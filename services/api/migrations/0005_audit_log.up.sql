-- 0005 audit log.
--
-- Every sensitive admin action must leave an attributable trail: who did it,
-- what they did, to whom, when, and whether it worked.
--
-- The motivating case is money. An admin can credit a wallet, change the
-- commission rate, and resolve a dispute with a monetary adjustment. Without
-- this table those actions are indistinguishable from each other in hindsight,
-- and "who credited this driver 500,000 dinars" has no answer.

CREATE TYPE audit_result AS ENUM ('SUCCESS', 'FAILURE');

CREATE TABLE audit_log (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The acting admin. RESTRICT, not CASCADE: deleting a user must never
  -- silently erase the record of what they did.
  actor_id       UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_role     user_role   NOT NULL,

  -- A stable machine-readable verb, e.g. 'driver.suspend', 'wallet.topup'.
  action         TEXT        NOT NULL,

  -- What was acted upon. Free-form type + id rather than a foreign key,
  -- because the target may be a driver, a ride, a dispute, or a config key.
  target_type    TEXT        NOT NULL,
  target_id      TEXT        NULL,

  result         audit_result NOT NULL,

  -- Ties the entry to the request that produced it, and to every log line that
  -- request emitted (CLAUDE.md §9).
  correlation_id TEXT        NOT NULL,

  -- Action-specific detail. MUST NOT contain PII: no phone numbers, no full
  -- names, no exact coordinates (CLAUDE.md §9). Amounts and ids only.
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT audit_action_len CHECK (char_length(action) BETWEEN 1 AND 120),
  CONSTRAINT audit_target_type_len CHECK (char_length(target_type) BETWEEN 1 AND 60)
);

-- Serves "what did this admin do?" - the first question asked in an incident.
CREATE INDEX audit_log_actor_created_idx ON audit_log (actor_id, created_at DESC);

-- Serves "what happened to this driver / ride / dispute?"
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, created_at DESC);

-- Serves the admin timeline view and the retention sweeper.
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

-- Serves "show me every failed admin action", which is where abuse shows first.
CREATE INDEX audit_log_failures_idx ON audit_log (created_at DESC) WHERE result = 'FAILURE';

-- Append-only, for the same reason the ledger is (CLAUDE.md §6.3): an audit
-- trail that can be edited is not an audit trail. Reuses the trigger function
-- installed in migration 0002.
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
