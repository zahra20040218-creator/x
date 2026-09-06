-- Reverse 0016.
--
-- A real DROP, which is only possible because no `payment_method` enum value
-- was added: PostgreSQL has ALTER TYPE ... ADD VALUE and no DROP VALUE, so an
-- enum change here would have made this file a lie.
--
-- Dropping the table loses the record of gateway attempts. The LEDGER rows they
-- produced survive - they are append-only by CLAUDE.md 6.3 and are referenced
-- by nothing here - so reversing this loses the reconciliation trail and never
-- the money.

DROP TABLE IF EXISTS gateway_payments;
DROP TYPE IF EXISTS gateway_payment_purpose;
DROP TYPE IF EXISTS gateway_payment_status;
DELETE FROM platform_config WHERE key = 'gateway_enabled';
