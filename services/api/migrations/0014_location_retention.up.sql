-- 0014 a retention policy for driver location history.
--
-- ## The defect
--
-- `driver_location_history` is written by the 30-second flush job for every
-- online driver (CLAUDE.md 3.1), and NOTHING has ever deleted from it. Migration
-- 0004 even built `driver_location_history_recorded_at_idx`, which serves
-- exactly one kind of query - "everything older than X" - and no such query was
-- ever written. The index has been maintained on every insert for a sweep that
-- did not exist.
--
-- ## Why it matters more than the row count
--
-- The row count is bad on its own: a driver working an eight-hour shift
-- produces roughly 960 rows a day, so fifty drivers produce about 17 million
-- rows a year, each carrying a GEOGRAPHY point and three float columns.
--
-- The privacy exposure is worse. This is the most sensitive data in the system
-- - precise coordinates tied to a named person, continuously, over time.
-- CLAUDE.md 9 forbids putting exact coordinates in a LOG LINE; retaining them
-- indefinitely in a queryable table is a stronger version of the same hazard.
-- And `docs/IRAQ_REGULATORY.md` records a forthcoming Iraqi data protection law,
-- which turns unbounded retention from an ethical problem into a legal one.
--
-- ## The policy row, not a hardcoded interval
--
-- Same shape as every other policy in this schema: a `platform_config` row an
-- owner can change without a deploy. 90 days is longer than any route dispute a
-- rider or driver is realistically going to open, and short enough that the
-- table stays a working set rather than an archive.
--
-- Seeded to 90 and NOT to 0. Every other policy in this repository ships
-- disabled, and this one deliberately does not: an absent retention policy is
-- how data accumulates forever by omission rather than by decision. An operator
-- who has been told to keep everything sets it to 0 explicitly.
--
-- The sweep itself is a BullMQ job (`location-retention`), batched, so it can
-- never take a long lock on a table the flush job is writing to.

INSERT INTO platform_config (key, value, description) VALUES
  ('location_retention_days', '90',
   'Days of driver_location_history to keep. 0 disables the sweep. CLAUDE.md 9.')
ON CONFLICT (key) DO NOTHING;
