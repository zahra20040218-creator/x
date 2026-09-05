-- Reverse 0015.
--
-- Drops the column and the sequence. It does NOT restore any erased phone
-- number or display name, because nothing kept them - that is the entire point
-- of the forward migration, and a down migration that implied otherwise would
-- be lying about what the system can do.
--
-- CLAUDE.md 12.9 forbids dropping a column holding production data without a
-- two-phase plan. `deleted_at` holds a timestamp, not user data; reversing this
-- loses the record of WHEN an account was erased while leaving the erasure
-- itself permanent. Reverse it only before any account has been deleted.

DROP INDEX IF EXISTS users_deleted_at_idx;
ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;
DROP SEQUENCE IF EXISTS deleted_account_seq;
