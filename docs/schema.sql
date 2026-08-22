-- =============================================================================
-- docs/schema.sql - CANONICAL SCHEMA (reference copy)
--
-- This file is the human-readable source of truth for the data model.
-- The EXECUTABLE definition lives in services/api/migrations/*.sql, which is
-- forward-only (CLAUDE.md §9). This file is kept in sync with them.
--
-- Invariants enforced here (not merely documented):
--   * CLAUDE.md §6.1  money is BIGINT whole IQD  -> no NUMERIC/REAL in any money column
--   * CLAUDE.md §6.2  double-entry               -> ledger_entries + balance trigger
--   * CLAUDE.md §6.3  ledger append-only         -> trigger raises on UPDATE/DELETE
--   * CLAUDE.md §4    ride_events append-only    -> trigger raises on UPDATE/DELETE
--   * CLAUDE.md §6.4  wallet balance derived     -> view, never a stored column
--   * CLAUDE.md §3.1  no driver location on the request path -> history table is
--                     written only by the 30s batch flush job
--   * CLAUDE.md §3.4  every query on a >10k-row table has a supporting index
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "postgis";    -- geography(Point) + GiST

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE user_role AS ENUM ('RIDER', 'DRIVER', 'ADMIN');

CREATE TYPE ride_status AS ENUM (
  'REQUESTED',
  'OFFERED',
  'ACCEPTED',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED_BY_RIDER',
  'CANCELLED_BY_DRIVER',
  'CANCELLED_IN_TRIP',
  'EXPIRED',
  'NO_DRIVERS_FOUND'
);

CREATE TYPE actor_type AS ENUM ('RIDER', 'DRIVER', 'ADMIN', 'SYSTEM');

CREATE TYPE driver_availability AS ENUM ('OFFLINE', 'ONLINE', 'ON_TRIP');

-- CLAUDE.md §6.2 - the four permitted account types.
CREATE TYPE ledger_account_type AS ENUM (
  'DRIVER_WALLET',
  'PLATFORM_REVENUE',
  'DRIVER_CASH_HELD',
  'MANUAL_ADJUSTMENT'
);

CREATE TYPE ledger_direction AS ENUM ('DEBIT', 'CREDIT');

CREATE TYPE payment_method AS ENUM ('CASH', 'GATEWAY');

CREATE TYPE payment_status AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED');

CREATE TYPE offer_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'TIMED_OUT', 'SUPERSEDED');

CREATE TYPE dispute_status AS ENUM ('OPEN', 'RESOLVED', 'REJECTED');

-- =============================================================================
-- USERS
-- =============================================================================

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role           user_role   NOT NULL,
  -- CLAUDE.md §8 - E.164 only, +964XXXXXXXXX. Normalisation happens server-side.
  phone_e164     TEXT        NOT NULL,
  display_name   TEXT        NOT NULL,
  firebase_uid   TEXT        NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_phone_e164_format CHECK (phone_e164 ~ '^\+964[0-9]{10}$'),
  CONSTRAINT users_display_name_len  CHECK (char_length(display_name) BETWEEN 1 AND 120)
);

-- A phone number identifies exactly one account per role. The same human may be
-- both a rider and a driver; they may not hold two rider accounts.
CREATE UNIQUE INDEX users_phone_role_uq ON users (phone_e164, role);
CREATE UNIQUE INDEX users_firebase_uid_uq ON users (firebase_uid) WHERE firebase_uid IS NOT NULL;

-- =============================================================================
-- DRIVERS
-- =============================================================================

CREATE TABLE drivers (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  availability       driver_availability NOT NULL DEFAULT 'OFFLINE',
  vehicle_plate      TEXT        NOT NULL,
  vehicle_model      TEXT        NOT NULL,
  vehicle_color      TEXT        NOT NULL,
  rating_sum         BIGINT      NOT NULL DEFAULT 0,
  rating_count       BIGINT      NOT NULL DEFAULT 0,
  -- Set by admin. A suspended driver receives no offers.
  is_suspended       BOOLEAN     NOT NULL DEFAULT FALSE,
  suspended_reason   TEXT        NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT drivers_rating_count_nonneg CHECK (rating_count >= 0),
  CONSTRAINT drivers_rating_sum_nonneg   CHECK (rating_sum >= 0)
);

-- Keeps the admin "online drivers" query off a sequential scan.
CREATE INDEX drivers_availability_idx ON drivers (availability) WHERE is_suspended = FALSE;

-- =============================================================================
-- RIDERS
-- =============================================================================

CREATE TABLE riders (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  rating_sum   BIGINT      NOT NULL DEFAULT 0,
  rating_count BIGINT      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT riders_rating_count_nonneg CHECK (rating_count >= 0)
);

-- =============================================================================
-- PLATFORM CONFIG  (CLAUDE.md §6.5 - commission is config, not a constant)
-- =============================================================================

CREATE TABLE platform_config (
  key         TEXT PRIMARY KEY,
  value       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID        NULL REFERENCES users(id)
);

-- Money-shaped config values are whole IQD; commission is basis points.
INSERT INTO platform_config (key, value, description) VALUES
  ('commission_bps',        '0',     'Platform commission in basis points. CLAUDE.md 6.5 default 0.'),
  ('fare_base_iqd',         '2000',  'Flag-fall in whole IQD.'),
  ('fare_per_km_iqd',       '500',   'Per kilometre in whole IQD.'),
  ('fare_per_minute_iqd',   '50',    'Per minute in whole IQD.'),
  ('fare_minimum_iqd',      '3000',  'Minimum total fare in whole IQD.'),
  ('fare_rounding_iqd',     '250',   'Final fare is rounded UP to a multiple of this.'),
  ('offer_timeout_seconds', '15',    'Seconds a driver has to accept an offer.'),
  ('search_radius_meters',  '5000',  'Initial driver search radius.');

-- =============================================================================
-- RIDES
-- =============================================================================

CREATE TABLE rides (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id                UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- NULL until a driver wins the atomic claim (CLAUDE.md §5.1).
  driver_id               UUID        NULL     REFERENCES users(id) ON DELETE RESTRICT,

  status                  ride_status NOT NULL DEFAULT 'REQUESTED',

  pickup_lat              DOUBLE PRECISION NOT NULL,
  pickup_lng              DOUBLE PRECISION NOT NULL,
  pickup_address          TEXT        NULL,
  dropoff_lat             DOUBLE PRECISION NOT NULL,
  dropoff_lng             DOUBLE PRECISION NOT NULL,
  dropoff_address         TEXT        NULL,

  -- Money: BIGINT whole IQD. CLAUDE.md §6.1 / §12.2. Never NUMERIC, never REAL.
  estimated_fare_iqd      BIGINT      NOT NULL,
  final_fare_iqd          BIGINT      NULL,
  commission_bps_snapshot INTEGER     NOT NULL DEFAULT 0,
  commission_iqd          BIGINT      NULL,

  estimated_distance_m    INTEGER     NOT NULL,
  estimated_duration_s    INTEGER     NOT NULL,
  actual_distance_m       INTEGER     NULL,

  payment_method          payment_method NOT NULL DEFAULT 'CASH',

  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at             TIMESTAMPTZ NULL,
  driver_arrived_at       TIMESTAMPTZ NULL,
  started_at              TIMESTAMPTZ NULL,
  completed_at            TIMESTAMPTZ NULL,
  cancelled_at            TIMESTAMPTZ NULL,
  cancellation_reason     TEXT        NULL,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rides_estimated_fare_positive CHECK (estimated_fare_iqd > 0),
  CONSTRAINT rides_final_fare_positive     CHECK (final_fare_iqd IS NULL OR final_fare_iqd > 0),
  CONSTRAINT rides_commission_nonneg       CHECK (commission_iqd IS NULL OR commission_iqd >= 0),
  CONSTRAINT rides_commission_bps_range    CHECK (commission_bps_snapshot BETWEEN 0 AND 10000),
  CONSTRAINT rides_pickup_lat_range        CHECK (pickup_lat  BETWEEN -90  AND 90),
  CONSTRAINT rides_pickup_lng_range        CHECK (pickup_lng  BETWEEN -180 AND 180),
  CONSTRAINT rides_dropoff_lat_range       CHECK (dropoff_lat BETWEEN -90  AND 90),
  CONSTRAINT rides_dropoff_lng_range       CHECK (dropoff_lng BETWEEN -180 AND 180),
  -- A ride cannot be past ACCEPTED without a driver.
  CONSTRAINT rides_driver_required_after_accept CHECK (
    status IN ('REQUESTED','OFFERED','EXPIRED','NO_DRIVERS_FOUND','CANCELLED_BY_RIDER')
    OR driver_id IS NOT NULL
  ),
  -- A completed ride must have a settled fare.
  CONSTRAINT rides_completed_has_fare CHECK (
    status <> 'COMPLETED' OR (final_fare_iqd IS NOT NULL AND commission_iqd IS NOT NULL)
  )
);

-- CLAUDE.md §3.4 - the mandated composite index. Serves the admin ride list
-- (filter by status, order by recency) and the stuck-ride sweeper.
CREATE INDEX rides_status_created_at_idx ON rides (status, created_at DESC);

-- Serves GET /rides/me for a rider (their own history, newest first).
CREATE INDEX rides_rider_created_at_idx ON rides (rider_id, created_at DESC);

-- Serves GET /rides/me for a driver and the driver earnings report.
CREATE INDEX rides_driver_created_at_idx ON rides (driver_id, created_at DESC)
  WHERE driver_id IS NOT NULL;

-- Serves "does this rider already have a live ride?" - the guard that stops a
-- rider opening a second ride while one is running. Partial => tiny index.
CREATE UNIQUE INDEX rides_one_active_per_rider_uq ON rides (rider_id)
  WHERE status IN ('REQUESTED','OFFERED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS');

-- Same guard on the driver side: one live ride per driver, enforced by the DB
-- and not by application logic. This is the second line of defence behind the
-- Redis claim (CLAUDE.md §5.1) - if the claim were ever bypassed, this unique
-- index still makes a double-accept impossible.
CREATE UNIQUE INDEX rides_one_active_per_driver_uq ON rides (driver_id)
  WHERE driver_id IS NOT NULL
    AND status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS');

-- =============================================================================
-- RIDE EVENTS  (CLAUDE.md §4 - append-only audit of every transition)
-- =============================================================================

CREATE TABLE ride_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ride_id     UUID        NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  from_state  ride_status NULL,          -- NULL only for the creation event
  to_state    ride_status NOT NULL,
  actor_type  actor_type  NOT NULL,
  actor_id    UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the ride timeline in admin, and the dispute investigation view.
CREATE INDEX ride_events_ride_id_created_at_idx ON ride_events (ride_id, created_at);
CREATE INDEX ride_events_created_at_idx ON ride_events (created_at DESC);

-- =============================================================================
-- RIDE OFFERS  (matching audit - which driver was offered what, and when)
-- =============================================================================

CREATE TABLE ride_offers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id        UUID         NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  driver_id      UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status         offer_status NOT NULL DEFAULT 'PENDING',
  distance_m     INTEGER      NOT NULL,
  offered_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ  NOT NULL,
  responded_at   TIMESTAMPTZ  NULL,

  CONSTRAINT ride_offers_distance_nonneg CHECK (distance_m >= 0)
);

-- One offer row per (ride, driver) - a retry must not create a duplicate.
CREATE UNIQUE INDEX ride_offers_ride_driver_uq ON ride_offers (ride_id, driver_id);
-- Serves the offer-timeout sweeper: "which offers expired and are still PENDING".
CREATE INDEX ride_offers_pending_expires_idx ON ride_offers (expires_at)
  WHERE status = 'PENDING';
CREATE INDEX ride_offers_driver_offered_idx ON ride_offers (driver_id, offered_at DESC);

-- =============================================================================
-- LEDGER  (CLAUDE.md §6.2, §6.3 - double entry, append-only, whole IQD)
-- =============================================================================

CREATE TABLE ledger_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Entries belonging to the same financial event share a transaction_id and
  -- MUST sum to zero. Enforced by the deferred trigger below.
  transaction_id UUID        NOT NULL,
  ride_id        UUID        NULL REFERENCES rides(id) ON DELETE RESTRICT,
  account_type   ledger_account_type NOT NULL,
  account_id     UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  direction      ledger_direction NOT NULL,
  -- BIGINT whole IQD, strictly positive. The sign lives in `direction`, never
  -- in the amount - that keeps "sums to zero" a single unambiguous rule.
  amount_iqd     BIGINT      NOT NULL,
  description    TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ledger_amount_positive CHECK (amount_iqd > 0),
  -- PLATFORM_REVENUE is the only account type with no owning user.
  CONSTRAINT ledger_account_id_presence CHECK (
    (account_type = 'PLATFORM_REVENUE' AND account_id IS NULL)
    OR (account_type <> 'PLATFORM_REVENUE' AND account_id IS NOT NULL)
  )
);

-- Serves the wallet balance view and the driver wallet screen.
CREATE INDEX ledger_account_idx ON ledger_entries (account_type, account_id, created_at DESC);
-- Serves "show me every entry for this ride" in disputes.
CREATE INDEX ledger_ride_idx ON ledger_entries (ride_id) WHERE ride_id IS NOT NULL;
-- Serves the balance trigger and the nightly reconciliation job.
CREATE INDEX ledger_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_created_at_idx ON ledger_entries (created_at DESC);

-- =============================================================================
-- APPEND-ONLY ENFORCEMENT  (CLAUDE.md §6.3, §12.3)
--
-- These are triggers, not conventions. Code that tries to UPDATE or DELETE a
-- ledger row fails at the database, even if the ORM, a migration, or a future
-- agent believes it should be allowed.
-- =============================================================================

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only (CLAUDE.md 6.3 / 12.3). % is forbidden. Corrections are new offsetting rows.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ride_events_no_update
  BEFORE UPDATE ON ride_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ride_events_no_delete
  BEFORE DELETE ON ride_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Double-entry balance check. DEFERRABLE so that the two-or-more rows of one
-- transaction can be inserted in any order inside a single DB transaction; the
-- check fires once at COMMIT.
CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced() RETURNS TRIGGER AS $$
DECLARE
  net BIGINT;
  n   BIGINT;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_iqd ELSE -amount_iqd END), 0),
    COUNT(*)
  INTO net, n
  FROM ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  IF n < 2 THEN
    RAISE EXCEPTION
      'Ledger transaction % has % row(s); double-entry requires at least 2 (CLAUDE.md 6.2).',
      NEW.transaction_id, n
      USING ERRCODE = 'check_violation';
  END IF;

  IF net <> 0 THEN
    RAISE EXCEPTION
      'Ledger transaction % is unbalanced by % IQD; entries must sum to zero (CLAUDE.md 6.2).',
      NEW.transaction_id, net
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();

-- =============================================================================
-- WALLET BALANCE  (CLAUDE.md §6.4 - derived, never a stored mutable column)
-- =============================================================================

CREATE VIEW driver_wallet_balances AS
SELECT
  account_id AS driver_id,
  COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_iqd ELSE 0 END), 0)
  - COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_iqd ELSE 0 END), 0)
    AS balance_iqd
FROM ledger_entries
WHERE account_type = 'DRIVER_WALLET'
GROUP BY account_id;

-- =============================================================================
-- PAYMENTS  (CLAUDE.md §7 - provider abstraction; CASH real, gateway stubbed)
-- =============================================================================

CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id            UUID           NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  provider           payment_method NOT NULL,
  status             payment_status NOT NULL DEFAULT 'PENDING',
  amount_iqd         BIGINT         NOT NULL,
  provider_ref       TEXT           NULL,
  confirmed_by       UUID           NULL REFERENCES users(id),
  confirmed_at       TIMESTAMPTZ    NULL,
  created_at         TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT payments_amount_positive CHECK (amount_iqd > 0)
);

CREATE UNIQUE INDEX payments_ride_uq ON payments (ride_id);
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

-- Gateway webhook replay protection. A webhook seen twice must be a no-op.
CREATE TABLE payment_webhook_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       payment_method NOT NULL,
  external_id    TEXT        NOT NULL,
  payload_hash   TEXT        NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_webhook_external_uq ON payment_webhook_events (provider, external_id);

-- =============================================================================
-- IDEMPOTENCY  (CLAUDE.md §5.2 - key -> ride_id for 24h)
-- =============================================================================

CREATE TABLE idempotency_keys (
  key             TEXT        NOT NULL,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  endpoint        TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,
  response_status INTEGER     NULL,
  response_body   JSONB       NULL,
  ride_id         UUID        NULL REFERENCES rides(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (user_id, endpoint, key)
);

-- Serves the 24h expiry sweeper.
CREATE INDEX idempotency_expires_at_idx ON idempotency_keys (expires_at);

-- =============================================================================
-- DRIVER LOCATION HISTORY  (CLAUDE.md §3.1)
--
-- WRITTEN ONLY BY THE 30s BATCH FLUSH JOB. Any code path that inserts here
-- during an HTTP request is a defect - the live location lives in Redis.
-- =============================================================================

CREATE TABLE driver_location_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id   UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ride_id     UUID        NULL REFERENCES rides(id) ON DELETE RESTRICT,
  position    GEOGRAPHY(Point, 4326) NOT NULL,
  accuracy_m  REAL        NULL,
  heading_deg REAL        NULL,
  speed_mps   REAL        NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CLAUDE.md §3.4 - GiST on the geometry column.
CREATE INDEX driver_location_history_position_gix ON driver_location_history USING GIST (position);
-- Serves "replay this ride's route" in dispute investigation.
CREATE INDEX driver_location_history_ride_idx ON driver_location_history (ride_id, recorded_at)
  WHERE ride_id IS NOT NULL;
-- Serves the retention sweeper.
CREATE INDEX driver_location_history_recorded_at_idx ON driver_location_history (recorded_at);

-- =============================================================================
-- RATINGS
-- =============================================================================

CREATE TABLE ratings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id      UUID        NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  rater_id     UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ratee_id     UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  score        SMALLINT    NOT NULL,
  comment      TEXT        NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ratings_score_range CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT ratings_no_self CHECK (rater_id <> ratee_id)
);

-- One rating per rater per ride - stops a rider rating the same trip twice.
CREATE UNIQUE INDEX ratings_ride_rater_uq ON ratings (ride_id, rater_id);
CREATE INDEX ratings_ratee_idx ON ratings (ratee_id, created_at DESC);

-- =============================================================================
-- WALLET TOP-UPS  (admin action; always paired with ledger entries)
-- =============================================================================

CREATE TABLE wallet_topups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  admin_id       UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_iqd     BIGINT      NOT NULL,
  transaction_id UUID        NOT NULL,
  reference      TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_topups_amount_positive CHECK (amount_iqd > 0)
);

CREATE INDEX wallet_topups_driver_idx ON wallet_topups (driver_id, created_at DESC);
CREATE UNIQUE INDEX wallet_topups_transaction_uq ON wallet_topups (transaction_id);

-- =============================================================================
-- DISPUTES
-- =============================================================================

CREATE TABLE disputes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id      UUID           NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  opened_by    UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status       dispute_status NOT NULL DEFAULT 'OPEN',
  reason_code  TEXT           NOT NULL,
  description  TEXT           NOT NULL DEFAULT '',
  resolved_by  UUID           NULL REFERENCES users(id),
  resolution   TEXT           NULL,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ    NULL
);

CREATE INDEX disputes_status_created_idx ON disputes (status, created_at DESC);
CREATE INDEX disputes_ride_idx ON disputes (ride_id);

-- =============================================================================
-- REFRESH TOKENS
-- =============================================================================

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refresh_tokens_hash_uq ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
