-- 0012 fare negotiation.
--
-- Owner decision 2026-08-25, recorded in CLAUDE.md §2 SCOPE EXPANSION and
-- docs/api-contract.yaml.
--
-- ## What this does NOT change
--
-- Nothing about §5.1. The atomic Redis claim still decides who gets a ride, and
-- nearest-driver dispatch stays as the fallback when nobody bids. A bid is a
-- driver's binding commitment to a price; when the rider selects one, the
-- server takes the claim on that driver's behalf and runs
-- REQUESTED -> OFFERED -> ACCEPTED through RideStateMachine unchanged.
--
-- That is the whole design, and it is deliberate: adding a second way for a
-- ride to acquire a driver would mean two code paths that must agree about
-- one-winner, and they would eventually disagree. There is still exactly one.
--
-- ## Disabled by default
--
-- `negotiation_enabled` is seeded 'false', following 0010 and 0011. With it
-- false, ride creation behaves exactly as it does today and the bid endpoints
-- 404. Turning it on is an owner decision in the admin panel, not a deploy.

-- ---------------------------------------------------------------------------
-- The fare a ride was agreed at
-- ---------------------------------------------------------------------------
--
-- Three fare columns now, and they are three different facts:
--
--   estimated_fare_iqd - what the tariff says the trip is worth
--   proposed_fare_iqd  - what the rider offered   (negotiation only)
--   agreed_fare_iqd    - what both parties settled on, if they negotiated
--   final_fare_iqd     - what was actually charged, set at completion
--
-- Collapsing any two of these loses the ability to answer a dispute. "The app
-- said 7,000 but he charged 9,000" is only answerable if the agreed price is
-- still on the row.

ALTER TABLE rides
  ADD COLUMN proposed_fare_iqd BIGINT
    CHECK (proposed_fare_iqd IS NULL OR proposed_fare_iqd > 0),
  ADD COLUMN agreed_fare_iqd   BIGINT
    CHECK (agreed_fare_iqd IS NULL OR agreed_fare_iqd > 0);

COMMENT ON COLUMN rides.proposed_fare_iqd IS
  'What the rider offered when negotiation is enabled. NULL for a direct-dispatch ride.';
COMMENT ON COLUMN rides.agreed_fare_iqd IS
  'The bid amount the rider accepted. NULL until a bid is accepted.';

-- ---------------------------------------------------------------------------
-- Bids
-- ---------------------------------------------------------------------------

-- SUPERSEDED, not "edited".
--
-- A driver who bids again writes a NEW row and the old one becomes SUPERSEDED.
-- An UPDATE would be simpler and would destroy the thing a fare dispute is
-- argued from: the sequence of prices each side actually named. This is the
-- same reasoning that makes ledger_entries append-only (CLAUDE.md §6.3), for
-- the same reason.
CREATE TYPE ride_bid_status AS ENUM (
  'ACTIVE',
  'SUPERSEDED',
  'WITHDRAWN',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED'
);

CREATE TABLE ride_bids (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id         UUID NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  driver_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- CLAUDE.md §6.1: BIGINT, whole Iraqi dinars. Never NUMERIC, never a float.
  amount_iqd      BIGINT NOT NULL CHECK (amount_iqd > 0),

  status          ride_bid_status NOT NULL DEFAULT 'ACTIVE',

  -- The driver's own estimate, not ours. Nullable because a driver may decline
  -- to give one and a fabricated ETA is worse than none.
  eta_seconds     INTEGER CHECK (eta_seconds IS NULL OR eta_seconds >= 0),

  -- Captured at bid time, not read live. The rider is comparing offers made at
  -- different moments and needs them on the same footing; a live distance would
  -- reorder the list under their thumb.
  distance_m      INTEGER NOT NULL CHECK (distance_m >= 0),

  -- The bid this one replaced, so the chain is walkable in a dispute.
  supersedes      UUID REFERENCES ride_bids(id),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  responded_at    TIMESTAMPTZ,

  CONSTRAINT ride_bids_expiry_after_creation CHECK (expires_at > created_at),
  -- A bid that is no longer ACTIVE must record when it stopped being active.
  -- Without this, "when was this rejected" is unanswerable and the audit trail
  -- has a hole exactly where a dispute needs it.
  CONSTRAINT ride_bids_resolved_has_time CHECK (
    (status IN ('ACTIVE')) = (responded_at IS NULL)
  )
);

-- One live bid per driver per ride.
--
-- Partial, on ACTIVE only, so the superseded history accumulates without ever
-- blocking a new bid. Same shape and same reasoning as
-- `rides_one_active_per_driver_uq`: the rule belongs in the database, not in
-- whichever code path remembers to check it.
CREATE UNIQUE INDEX ride_bids_one_active_per_driver_uq
  ON ride_bids (ride_id, driver_id)
  WHERE status = 'ACTIVE';

-- The rider's list: every active bid on one ride, cheapest first. CLAUDE.md
-- §3.4 - this is the query, and this is the index that serves it.
CREATE INDEX ride_bids_ride_amount_idx
  ON ride_bids (ride_id, amount_iqd)
  WHERE status = 'ACTIVE';

-- The sweep: which active bids have run out. Partial, so it never scans the
-- resolved history.
CREATE INDEX ride_bids_expiry_idx
  ON ride_bids (expires_at)
  WHERE status = 'ACTIVE';

-- A driver's own bids, newest first, for their app's list.
CREATE INDEX ride_bids_driver_created_idx
  ON ride_bids (driver_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Policy
-- ---------------------------------------------------------------------------
--
-- `negotiation_band_bps` bounds how far a bid may sit from the rider's
-- proposal, in basis points. 3000 = 30%.
--
-- It exists because of a specific abuse: without a floor, a driver bids 1 IQD,
-- wins the list because it sorts first, and renegotiates in the car with a
-- passenger who has nowhere else to go. A ceiling matters less but is symmetric
-- and costs nothing.
--
-- Basis points rather than a percentage, matching `commission_bps` - one unit
-- for proportions across the system means one way to get them wrong.
INSERT INTO platform_config (key, value) VALUES
  ('negotiation_enabled',    'false'),
  ('negotiation_band_bps',   '3000'),
  ('negotiation_window_seconds', '90')
ON CONFLICT (key) DO NOTHING;
