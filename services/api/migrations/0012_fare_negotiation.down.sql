-- Reverse of 0012.
--
-- The bid table goes before its enum, and the ride columns last: a partial
-- failure should leave the schema without negotiation rather than with a
-- half-removed one.

DROP INDEX IF EXISTS ride_bids_driver_created_idx;
DROP INDEX IF EXISTS ride_bids_expiry_idx;
DROP INDEX IF EXISTS ride_bids_ride_amount_idx;
DROP INDEX IF EXISTS ride_bids_one_active_per_driver_uq;
DROP TABLE IF EXISTS ride_bids;
DROP TYPE IF EXISTS ride_bid_status;

ALTER TABLE rides
  DROP COLUMN IF EXISTS agreed_fare_iqd,
  DROP COLUMN IF EXISTS proposed_fare_iqd;

DELETE FROM platform_config
 WHERE key IN ('negotiation_enabled', 'negotiation_band_bps', 'negotiation_window_seconds');
