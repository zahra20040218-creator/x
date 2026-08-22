-- 0003 ledger: double-entry, append-only, derived balances.
-- CLAUDE.md §6.2, §6.3, §6.4, §12.3.

CREATE TABLE ledger_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID        NOT NULL,
  ride_id        UUID        NULL REFERENCES rides(id) ON DELETE RESTRICT,
  account_type   ledger_account_type NOT NULL,
  account_id     UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  direction      ledger_direction NOT NULL,
  -- Whole IQD, strictly positive. The sign lives in `direction` so that
  -- "sums to zero" stays a single unambiguous rule.
  amount_iqd     BIGINT      NOT NULL,
  description    TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ledger_amount_positive CHECK (amount_iqd > 0),
  CONSTRAINT ledger_account_id_presence CHECK (
    (account_type = 'PLATFORM_REVENUE' AND account_id IS NULL)
    OR (account_type <> 'PLATFORM_REVENUE' AND account_id IS NOT NULL)
  )
);

CREATE INDEX ledger_account_idx ON ledger_entries (account_type, account_id, created_at DESC);
CREATE INDEX ledger_ride_idx ON ledger_entries (ride_id) WHERE ride_id IS NOT NULL;
CREATE INDEX ledger_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_created_at_idx ON ledger_entries (created_at DESC);

-- CLAUDE.md §6.3 / §12.3 - append-only, enforced by the database so that no
-- ORM, migration, or future agent can mutate a financial record.
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- CLAUDE.md §6.2 - entries of one transaction must sum to zero.
--
-- DEFERRABLE INITIALLY DEFERRED so the rows of one transaction can be inserted
-- in any order; the check runs once at COMMIT. A non-deferred trigger would
-- reject the first row of every legitimate pair.
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

-- CLAUDE.md §6.4 - balance is derived. There is no counter column to drift.
CREATE VIEW driver_wallet_balances AS
SELECT
  account_id AS driver_id,
  COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_iqd ELSE 0 END), 0)
  - COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_iqd ELSE 0 END), 0)
    AS balance_iqd
FROM ledger_entries
WHERE account_type = 'DRIVER_WALLET'
GROUP BY account_id;
