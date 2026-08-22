DROP VIEW IF EXISTS driver_wallet_balances;

DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries;
DROP TRIGGER IF EXISTS ledger_entries_no_delete ON ledger_entries;
DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries;

DROP FUNCTION IF EXISTS assert_ledger_transaction_balanced();

DROP TABLE IF EXISTS ledger_entries;

-- forbid_mutation() is shared with 0002's ride_events triggers, and 0002 rolls
-- back AFTER this file (down order is 0004, 0003, 0002, 0001). CASCADE is
-- therefore required, and it drops those still-live triggers too; 0002's own
-- DROP TRIGGER IF EXISTS statements are then no-ops rather than errors.
DROP FUNCTION IF EXISTS forbid_mutation() CASCADE;
