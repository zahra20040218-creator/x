-- 0016 the live collection rail.
--
-- Owner decision, 2026-09-06, recorded in DECISIONS.md D-024. CLAUDE.md §2 was
-- amended the same day to permit ONE live gateway, for driver-side collections
-- only.
--
-- ## Why this is a new table and not a row in `payments`
--
-- `payments.ride_id` is `NOT NULL` with a UNIQUE index. A subscription has no
-- ride, so it cannot live there - and widening that column would weaken the
-- one constraint guaranteeing a ride settles exactly once.
--
-- The two are different objects anyway. A `payments` row records money that
-- already moved, hand to hand, and is CONFIRMED the moment it is written. A
-- gateway attempt is a promise: it exists before the money does, may never be
-- paid, and its whole reason for existing is the window in between. Nothing in
-- this system modelled that window - `payment_status` had a PENDING value that
-- no code ever wrote.
--
-- ## `reference_id` is ours, generated first
--
-- ALY mints the reference and sends it to the provider, rather than storing an
-- id the provider returns. That ordering is the difference between a lost
-- reply being recoverable and being money that vanished: if the call times out
-- after the provider created the link, the row already exists and the
-- reconciliation job can ask about it by name.
--
-- ## No new `payment_method` enum value
--
-- Adding one means `ALTER TYPE ... ADD VALUE`, which PostgreSQL cannot undo -
-- there is no DROP VALUE - so it would make the down migration a file that
-- exists and does not work. The provider is a TEXT column here, and the down
-- migration is a real DROP TABLE.

CREATE TYPE gateway_payment_status AS ENUM (
  'PENDING',   -- link created, nobody has paid
  'PAID',      -- provider confirmed; ledger written
  'FAILED',    -- provider declined
  'EXPIRED',   -- the window closed unpaid
  'REFUNDED'
);

CREATE TYPE gateway_payment_purpose AS ENUM ('SUBSCRIPTION', 'WALLET_TOPUP');

CREATE TABLE gateway_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ours, sent to the provider, echoed back on the webhook. Unique because it
  -- is the reconciliation key: two rows sharing one would make an incoming
  -- confirmation ambiguous, which is the one thing it must never be.
  reference_id    UUID NOT NULL UNIQUE,

  provider        TEXT NOT NULL,
  purpose         gateway_payment_purpose NOT NULL,
  status          gateway_payment_status NOT NULL DEFAULT 'PENDING',

  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- CLAUDE.md §6.1: whole Iraqi dinars, BIGINT, never a decimal type.
  --
  -- `amount_iqd` is what the driver pays. `fee_iqd` is what the processor keeps
  -- and is NULL until settlement, because it is not knowable in advance - the
  -- published rate is 2.5% + 600 IQD but the authoritative number is whatever
  -- the provider reports.
  amount_iqd      BIGINT NOT NULL CHECK (amount_iqd > 0),
  fee_iqd         BIGINT CHECK (fee_iqd >= 0),

  -- Which plan this attempt was for. Nullable because a wallet top-up has none.
  plan_id         UUID REFERENCES subscription_plans(id) ON DELETE RESTRICT,

  checkout_url    TEXT,
  provider_ref    TEXT,

  -- The ledger transaction written at settlement. NULL while PENDING, and the
  -- proof that a PAID row moved money exactly once.
  transaction_id  UUID,

  expires_at      TIMESTAMPTZ,
  settled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A settled row must say when, and a PAID row must name its ledger entry.
  -- Without this a paid attempt with no transaction id looks identical to one
  -- that paid and never reached the ledger.
  CONSTRAINT gateway_payments_settled_has_time
    CHECK ((status IN ('PENDING')) OR (settled_at IS NOT NULL)),
  CONSTRAINT gateway_payments_paid_has_transaction
    CHECK ((status <> 'PAID') OR (transaction_id IS NOT NULL))
);

-- One open attempt per user.
--
-- Partial, on PENDING only, so failed and expired attempts accumulate as
-- history without blocking a retry. Without it a driver who taps twice gets two
-- live checkout links and can pay both - and the second payment has no
-- subscription to buy.
CREATE UNIQUE INDEX gateway_payments_one_pending_uq
  ON gateway_payments (user_id)
  WHERE status = 'PENDING';

-- The reconciliation sweep: "which PENDING attempts should I ask about".
CREATE INDEX gateway_payments_pending_idx
  ON gateway_payments (created_at)
  WHERE status = 'PENDING';

-- A driver's own payment history, newest first.
CREATE INDEX gateway_payments_user_idx
  ON gateway_payments (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Policy
-- ---------------------------------------------------------------------------
--
-- Seeded FALSE, following 0010, 0011 and 0012. With it false the checkout
-- endpoint answers 501 and no outbound call is ever made, so deploying this
-- migration changes nothing for anyone until an owner switches it on.
INSERT INTO platform_config (key, value, description) VALUES
  ('gateway_enabled', 'false',
   'Whether the live collection rail accepts checkouts. CLAUDE.md 2, D-024.')
ON CONFLICT (key) DO NOTHING;
