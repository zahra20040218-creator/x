-- Reverse of 0011.
--
-- Order matters: the tables go before the types they use, and the config row
-- goes last so a partial failure leaves the policy off rather than on.

DROP INDEX IF EXISTS driver_subscriptions_expiry_idx;
DROP INDEX IF EXISTS driver_subscriptions_one_active_uq;
DROP TABLE IF EXISTS driver_subscriptions;
DROP TYPE IF EXISTS subscription_status;
DROP TABLE IF EXISTS subscription_plans;

DROP INDEX IF EXISTS drivers_pending_approval_idx;

ALTER TABLE drivers
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approval_note,
  DROP COLUMN IF EXISTS approval_status;

DROP TYPE IF EXISTS driver_approval_status;

DELETE FROM platform_config WHERE key = 'subscription_required';
