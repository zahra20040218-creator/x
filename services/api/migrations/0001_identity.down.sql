-- Reverses 0001. CLAUDE.md §9 requires migrations to run cleanly down as well
-- as up; `make migrate-down` on a fresh DB is part of the Definition of Done.

DROP TABLE IF EXISTS platform_config;
DROP TABLE IF EXISTS riders;
DROP TABLE IF EXISTS drivers;
DROP TABLE IF EXISTS users;

DROP TYPE IF EXISTS dispute_status;
DROP TYPE IF EXISTS offer_status;
DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS payment_method;
DROP TYPE IF EXISTS ledger_direction;
DROP TYPE IF EXISTS ledger_account_type;
DROP TYPE IF EXISTS driver_availability;
DROP TYPE IF EXISTS actor_type;
DROP TYPE IF EXISTS ride_status;
DROP TYPE IF EXISTS user_role;

-- Extensions are deliberately NOT dropped: they may be shared with other
-- schemas in the same database, and dropping postgis is expensive to undo.
