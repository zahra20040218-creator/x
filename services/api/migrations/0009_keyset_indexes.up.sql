-- 0009 keyset indexes for the remaining paginated listings.
--
-- Companion to 0008, which covered the ledger. Every cursor in the API now
-- orders by and compares the tuple (created_at, id) rather than created_at
-- alone, for the reasons in services/api/src/http/cursor.ts: created_at is not
-- unique, `now()` is the transaction timestamp so ties are normal, and a
-- timestamp cannot survive a round trip through a millisecond-precision
-- JavaScript Date.
--
-- Each index below appends `id DESC` to an existing one so the range scan and
-- the ORDER BY are both satisfied without a sort. CLAUDE.md §3.4.
--
-- The originals are kept: they still serve the equality and aggregate queries
-- that do not order by id, and dropping an index a running query is using is
-- not a change worth bundling with this one.

-- Rider and driver ride history.
CREATE INDEX rides_rider_keyset_idx  ON rides (rider_id, created_at DESC, id DESC);
CREATE INDEX rides_driver_keyset_idx ON rides (driver_id, created_at DESC, id DESC)
  WHERE driver_id IS NOT NULL;

-- Admin ride list: no leading filter column, so this one is ordered only.
CREATE INDEX rides_keyset_idx ON rides (created_at DESC, id DESC);

-- Admin driver list. `users` is not expected to pass 10k rows in a single
-- city, so this is about the ordering being stable rather than about scan cost.
CREATE INDEX users_role_keyset_idx ON users (role, created_at DESC, id DESC);

-- Admin dispute queue.
CREATE INDEX disputes_keyset_idx ON disputes (created_at DESC, id DESC);
