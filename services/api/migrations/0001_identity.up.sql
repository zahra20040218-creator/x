-- 0001 identity: extensions, enums, users, drivers, riders, platform config.
-- Forward-only (CLAUDE.md §9). Never edit this file once it has been applied.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "postgis";

CREATE TYPE user_role AS ENUM ('RIDER', 'DRIVER', 'ADMIN');

CREATE TYPE ride_status AS ENUM (
  'REQUESTED', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS',
  'COMPLETED', 'CANCELLED_BY_RIDER', 'CANCELLED_BY_DRIVER',
  'CANCELLED_IN_TRIP', 'EXPIRED', 'NO_DRIVERS_FOUND'
);

CREATE TYPE actor_type AS ENUM ('RIDER', 'DRIVER', 'ADMIN', 'SYSTEM');

CREATE TYPE driver_availability AS ENUM ('OFFLINE', 'ONLINE', 'ON_TRIP');

CREATE TYPE ledger_account_type AS ENUM (
  'DRIVER_WALLET', 'PLATFORM_REVENUE', 'DRIVER_CASH_HELD', 'MANUAL_ADJUSTMENT'
);

CREATE TYPE ledger_direction AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE payment_method AS ENUM ('CASH', 'GATEWAY');
CREATE TYPE payment_status AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED');
CREATE TYPE offer_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'TIMED_OUT', 'SUPERSEDED');
CREATE TYPE dispute_status AS ENUM ('OPEN', 'RESOLVED', 'REJECTED');

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role           user_role   NOT NULL,
  phone_e164     TEXT        NOT NULL,
  display_name   TEXT        NOT NULL,
  firebase_uid   TEXT        NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_phone_e164_format CHECK (phone_e164 ~ '^\+964[0-9]{10}$'),
  CONSTRAINT users_display_name_len  CHECK (char_length(display_name) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX users_phone_role_uq ON users (phone_e164, role);
CREATE UNIQUE INDEX users_firebase_uid_uq ON users (firebase_uid) WHERE firebase_uid IS NOT NULL;

CREATE TABLE drivers (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  availability       driver_availability NOT NULL DEFAULT 'OFFLINE',
  vehicle_plate      TEXT        NOT NULL,
  vehicle_model      TEXT        NOT NULL,
  vehicle_color      TEXT        NOT NULL,
  rating_sum         BIGINT      NOT NULL DEFAULT 0,
  rating_count       BIGINT      NOT NULL DEFAULT 0,
  is_suspended       BOOLEAN     NOT NULL DEFAULT FALSE,
  suspended_reason   TEXT        NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT drivers_rating_count_nonneg CHECK (rating_count >= 0),
  CONSTRAINT drivers_rating_sum_nonneg   CHECK (rating_sum >= 0)
);

CREATE INDEX drivers_availability_idx ON drivers (availability) WHERE is_suspended = FALSE;

CREATE TABLE riders (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  rating_sum   BIGINT      NOT NULL DEFAULT 0,
  rating_count BIGINT      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT riders_rating_count_nonneg CHECK (rating_count >= 0)
);

CREATE TABLE platform_config (
  key         TEXT PRIMARY KEY,
  value       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID        NULL REFERENCES users(id)
);

-- CLAUDE.md §6.5 - commission default is 0 and changing it must not need a deploy.
INSERT INTO platform_config (key, value, description) VALUES
  ('commission_bps',        '0',     'Platform commission in basis points. CLAUDE.md 6.5 default 0.'),
  ('fare_base_iqd',         '2000',  'Flag-fall in whole IQD.'),
  ('fare_per_km_iqd',       '500',   'Per kilometre in whole IQD.'),
  ('fare_per_minute_iqd',   '50',    'Per minute in whole IQD.'),
  ('fare_minimum_iqd',      '3000',  'Minimum total fare in whole IQD.'),
  ('fare_rounding_iqd',     '250',   'Final fare is rounded UP to a multiple of this.'),
  ('offer_timeout_seconds', '15',    'Seconds a driver has to accept an offer.'),
  ('search_radius_meters',  '5000',  'Initial driver search radius.');
