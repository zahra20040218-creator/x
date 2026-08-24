-- 0008 ledger keyset index.
--
-- The statement was paginated with `created_at < cursor` under
-- `ORDER BY created_at DESC`. That is not a total order, and PostgreSQL `now()`
-- is the TRANSACTION timestamp, so every row a settlement writes shares one
-- `created_at`. A page boundary inside such a group dropped the rest of it -
-- money the driver earned and never saw on their statement.
--
-- The query now compares and orders by the tuple (created_at, id). This index
-- serves it: the leading columns match the WHERE, and the trailing pair matches
-- the ORDER BY, so the range scan needs no sort. CLAUDE.md §3.4.
--
-- ledger_account_idx is left in place: it still serves the balance aggregate,
-- which does not order by id.

CREATE INDEX ledger_account_keyset_idx
  ON ledger_entries (account_type, account_id, created_at DESC, id DESC);
