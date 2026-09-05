-- Reverse 0014.
--
-- Removes the policy row. Deliberately does NOT restore any rows the sweep
-- deleted: the ledger is not the only append-only thing here in spirit, and a
-- down migration that pretended to undo a deletion would be lying. Reversing
-- this returns the system to "retains forever", which is the state 0014 was
-- written to end - so reverse it only to change the number, not to keep data.

DELETE FROM platform_config WHERE key = 'location_retention_days';
