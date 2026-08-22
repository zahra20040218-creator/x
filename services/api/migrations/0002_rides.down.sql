DROP TRIGGER IF EXISTS ride_events_no_delete ON ride_events;
DROP TRIGGER IF EXISTS ride_events_no_update ON ride_events;

DROP TABLE IF EXISTS ride_offers;
DROP TABLE IF EXISTS ride_events;
DROP TABLE IF EXISTS rides;

-- forbid_mutation() is shared with 0003; it is dropped there, which runs first
-- on the way down.
