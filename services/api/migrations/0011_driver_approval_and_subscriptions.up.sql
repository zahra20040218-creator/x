-- 0011 driver approval state and subscriptions.
--
-- Owner decision, 2026-08-25, recorded in CLAUDE.md §2 SCOPE EXPANSION: ALY
-- ships as one app with a Driver mode, and the server decides who may enter it.
-- This migration adds the two facts that decision needs and that the schema did
-- not already hold.
--
-- ## What was already here, and is NOT duplicated
--
--   users.is_active        - banned
--   drivers.is_suspended   - suspended, with a reason
--   driver_documents       - identity, licence, vehicle registration, with
--                            expiry derived at read time (see 0010)
--
-- The capability check reads all of those. Re-encoding any of them as a second
-- column is how two sources of truth disagree.
--
-- ## Approval is a state, not a derived value
--
-- It would be tempting to derive "approved" from "every required document is
-- VERIFIED". That is wrong for a reason that only shows up in operations: an
-- owner must be able to admit a driver whose paperwork is complete and still
-- refuse one whose paperwork is complete, and to revoke admission without
-- deleting verified documents. Approval is a human decision about a person;
-- document verification is a clerical fact about a piece of paper.
--
-- Default APPROVED, deliberately. Every driver in the system today was created
-- by an administrator by hand and is working. A default of PENDING would put
-- all of them out of work on deploy, which is a data migration disguised as a
-- schema change.

CREATE TYPE driver_approval_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE drivers
  ADD COLUMN approval_status   driver_approval_status NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN approval_note     TEXT,
  ADD COLUMN approved_by       UUID REFERENCES users(id),
  ADD COLUMN approved_at       TIMESTAMPTZ;

COMMENT ON COLUMN drivers.approval_status IS
  'Whether an administrator admits this driver. Distinct from document verification.';

-- Serves the capability check, which asks for one driver by id and their
-- approval in the same breath. The partial index is for the admin queue, which
-- only ever looks at PENDING.
CREATE INDEX drivers_pending_approval_idx
  ON drivers (created_at DESC)
  WHERE approval_status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
--
-- CLAUDE.md §6 governs money and it is not relaxed here. A subscription charge
-- is an ordinary double-entry transaction against the existing ledger:
--
--   DEBIT  DRIVER_WALLET     amount
--   CREDIT PLATFORM_REVENUE  amount
--
-- This table holds the ENTITLEMENT - which plan, until when - and never a
-- balance. There is no `amount_paid` column and no counter to keep in step,
-- because the ledger already answers "what was charged" and a second answer
-- could disagree with it.
--
-- ## Why periods are rows, not columns on the driver
--
-- A renewal is a new row. Storing `subscription_expires_at` on `drivers` makes
-- the history unrecoverable the moment it is overwritten, and billing disputes
-- are exactly the case where history is the whole question.

CREATE TABLE subscription_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,
  name_ar         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  -- CLAUDE.md §6.1: whole Iraqi dinars, BIGINT, never a decimal type.
  price_iqd       BIGINT NOT NULL CHECK (price_iqd >= 0),
  duration_days   INTEGER NOT NULL CHECK (duration_days > 0),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE subscription_status AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

CREATE TABLE driver_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id         UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  status          subscription_status NOT NULL DEFAULT 'ACTIVE',
  -- The price actually charged, copied at purchase. A plan's price may change
  -- later; what this driver paid may not change with it.
  charged_iqd     BIGINT NOT NULL CHECK (charged_iqd >= 0),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  cancelled_at    TIMESTAMPTZ,
  -- The ledger transaction that paid for it. Nullable only for a subscription
  -- an administrator grants without charge.
  transaction_id  UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT driver_subscriptions_period CHECK (expires_at > started_at),
  CONSTRAINT driver_subscriptions_cancelled_has_time
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

-- One live subscription per driver.
--
-- Partial, on ACTIVE only, so expired and cancelled rows accumulate as history
-- without ever blocking a renewal. This is the same shape as
-- `rides_one_active_per_driver_uq` and it exists for the same reason: the rule
-- belongs in the database, not in whichever code path remembers to check.
CREATE UNIQUE INDEX driver_subscriptions_one_active_uq
  ON driver_subscriptions (driver_id)
  WHERE status = 'ACTIVE';

-- The capability check asks "is this driver's subscription still valid", and
-- the expiry sweep asks "which ACTIVE rows are past their date".
CREATE INDEX driver_subscriptions_expiry_idx
  ON driver_subscriptions (expires_at)
  WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Policy
-- ---------------------------------------------------------------------------
--
-- Seeded FALSE, following 0010's precedent. With it false, no driver is blocked
-- by a subscription and the check does not run a query. Turning it on is an
-- owner decision made in the admin panel, not a deploy.
INSERT INTO platform_config (key, value)
VALUES ('subscription_required', 'false')
ON CONFLICT (key) DO NOTHING;
