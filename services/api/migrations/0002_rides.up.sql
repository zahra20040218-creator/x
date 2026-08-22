-- 0002 rides: the ride, its append-only event log, and the offer audit.

CREATE TABLE rides (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id                UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  driver_id               UUID        NULL     REFERENCES users(id) ON DELETE RESTRICT,
  status                  ride_status NOT NULL DEFAULT 'REQUESTED',

  pickup_lat              DOUBLE PRECISION NOT NULL,
  pickup_lng              DOUBLE PRECISION NOT NULL,
  pickup_address          TEXT        NULL,
  dropoff_lat             DOUBLE PRECISION NOT NULL,
  dropoff_lng             DOUBLE PRECISION NOT NULL,
  dropoff_address         TEXT        NULL,

  -- CLAUDE.md §6.1 / §12.2 - BIGINT whole IQD. Never NUMERIC, never REAL.
  estimated_fare_iqd      BIGINT      NOT NULL,
  final_fare_iqd          BIGINT      NULL,
  commission_bps_snapshot INTEGER     NOT NULL DEFAULT 0,
  commission_iqd          BIGINT      NULL,

  estimated_distance_m    INTEGER     NOT NULL,
  estimated_duration_s    INTEGER     NOT NULL,
  actual_distance_m       INTEGER     NULL,

  payment_method          payment_method NOT NULL DEFAULT 'CASH',

  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at             TIMESTAMPTZ NULL,
  driver_arrived_at       TIMESTAMPTZ NULL,
  started_at              TIMESTAMPTZ NULL,
  completed_at            TIMESTAMPTZ NULL,
  cancelled_at            TIMESTAMPTZ NULL,
  cancellation_reason     TEXT        NULL,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rides_estimated_fare_positive CHECK (estimated_fare_iqd > 0),
  CONSTRAINT rides_final_fare_positive     CHECK (final_fare_iqd IS NULL OR final_fare_iqd > 0),
  CONSTRAINT rides_commission_nonneg       CHECK (commission_iqd IS NULL OR commission_iqd >= 0),
  CONSTRAINT rides_commission_bps_range    CHECK (commission_bps_snapshot BETWEEN 0 AND 10000),
  CONSTRAINT rides_pickup_lat_range        CHECK (pickup_lat  BETWEEN -90  AND 90),
  CONSTRAINT rides_pickup_lng_range        CHECK (pickup_lng  BETWEEN -180 AND 180),
  CONSTRAINT rides_dropoff_lat_range       CHECK (dropoff_lat BETWEEN -90  AND 90),
  CONSTRAINT rides_dropoff_lng_range       CHECK (dropoff_lng BETWEEN -180 AND 180),
  CONSTRAINT rides_driver_required_after_accept CHECK (
    status IN ('REQUESTED','OFFERED','EXPIRED','NO_DRIVERS_FOUND','CANCELLED_BY_RIDER')
    OR driver_id IS NOT NULL
  ),
  CONSTRAINT rides_completed_has_fare CHECK (
    status <> 'COMPLETED' OR (final_fare_iqd IS NOT NULL AND commission_iqd IS NOT NULL)
  )
);

-- CLAUDE.md §3.4 - the mandated composite index.
CREATE INDEX rides_status_created_at_idx ON rides (status, created_at DESC);
CREATE INDEX rides_rider_created_at_idx  ON rides (rider_id, created_at DESC);
CREATE INDEX rides_driver_created_at_idx ON rides (driver_id, created_at DESC)
  WHERE driver_id IS NOT NULL;

CREATE UNIQUE INDEX rides_one_active_per_rider_uq ON rides (rider_id)
  WHERE status IN ('REQUESTED','OFFERED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS');

-- The database-level backstop behind the Redis claim (CLAUDE.md §5.1). Even if
-- the claim were bypassed entirely, two drivers could not both hold a live ride.
CREATE UNIQUE INDEX rides_one_active_per_driver_uq ON rides (driver_id)
  WHERE driver_id IS NOT NULL
    AND status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS');

CREATE TABLE ride_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ride_id     UUID        NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  from_state  ride_status NULL,
  to_state    ride_status NOT NULL,
  actor_type  actor_type  NOT NULL,
  actor_id    UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ride_events_ride_id_created_at_idx ON ride_events (ride_id, created_at);
CREATE INDEX ride_events_created_at_idx ON ride_events (created_at DESC);

CREATE TABLE ride_offers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id        UUID         NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  driver_id      UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status         offer_status NOT NULL DEFAULT 'PENDING',
  distance_m     INTEGER      NOT NULL,
  offered_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ  NOT NULL,
  responded_at   TIMESTAMPTZ  NULL,

  CONSTRAINT ride_offers_distance_nonneg CHECK (distance_m >= 0)
);

CREATE UNIQUE INDEX ride_offers_ride_driver_uq ON ride_offers (ride_id, driver_id);
CREATE INDEX ride_offers_pending_expires_idx ON ride_offers (expires_at) WHERE status = 'PENDING';
CREATE INDEX ride_offers_driver_offered_idx ON ride_offers (driver_id, offered_at DESC);

-- CLAUDE.md §4: ride_events is append-only. Enforced, not merely intended.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only (CLAUDE.md 6.3 / 12.3). % is forbidden. Corrections are new offsetting rows.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ride_events_no_update
  BEFORE UPDATE ON ride_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ride_events_no_delete
  BEFORE DELETE ON ride_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
