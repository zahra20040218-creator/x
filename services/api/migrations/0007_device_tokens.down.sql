-- Reverses 0007.
--
-- Dropping this loses every registered device address, so the next push after
-- a rollback reaches nobody until the apps re-register on their next launch.
-- No durable record is lost: a device token is a routing address, not history.

DROP INDEX IF EXISTS device_tokens_user_live_idx;
DROP INDEX IF EXISTS device_tokens_token_uq;

DROP TABLE IF EXISTS device_tokens;

DROP TYPE IF EXISTS device_platform;
