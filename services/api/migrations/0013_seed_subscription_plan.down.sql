-- Reverse 0013.
--
-- Deactivates rather than deletes. `driver_subscriptions.plan_id` is
-- `REFERENCES subscription_plans(id) ON DELETE RESTRICT`, so once a single
-- driver has bought this plan a DELETE would fail and the down migration would
-- be a file that exists and does not work - which is exactly the failure the
-- CI down-then-up check exists to catch.
--
-- Deactivating is also the honest reversal. CLAUDE.md 6.3 makes the ledger
-- append-only; a period somebody paid for is a fact, and the plan it names has
-- to stay resolvable for that row to mean anything. `is_active = FALSE` removes
-- it from the purchasable list, which is the whole of what 0013 added.

UPDATE subscription_plans SET is_active = FALSE WHERE code = 'MONTHLY_25K';
