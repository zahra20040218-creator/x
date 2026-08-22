-- 0004 operations: payments, idempotency, location history, ratings, top-ups,
-- disputes, refresh tokens.

CREATE TABLE payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id      UUID           NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  provider     payment_method NOT NULL,
  status       payment_status NOT NULL DEFAULT 'PENDING',
  amount_iqd   BIGINT         NOT NULL,
  provider_ref TEXT           NULL,
  confirmed_by UUID           NULL REFERENCES users(id),
  confirmed_at TIMESTAMPTZ    NULL,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT payments_amount_positive CHECK (amount_iqd > 0)
);

CREATE UNIQUE INDEX payments_ride_uq ON payments (ride_id);
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

-- Replay protection for gateway callbacks (CLAUDE.md §7).
CREATE TABLE payment_webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     payment_method NOT NULL,
  external_id  TEXT        NOT NULL,
  payload_hash TEXT        NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_webhook_external_uq ON payment_webhook_events (provider, external_id);

-- CLAUDE.md §5.2 - key -> stored response for 24h.
CREATE TABLE idempotency_keys (
  key             TEXT        NOT NULL,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  endpoint        TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,
  response_status INTEGER     NULL,
  response_body   JSONB       NULL,
  ride_id         UUID        NULL REFERENCES rides(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (user_id, endpoint, key)
);

CREATE INDEX idempotency_expires_at_idx ON idempotency_keys (expires_at);

-- CLAUDE.md §3.1 - written ONLY by the 30s batch flush job, never on a request.
CREATE TABLE driver_location_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id   UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ride_id     UUID        NULL REFERENCES rides(id) ON DELETE RESTRICT,
  position    GEOGRAPHY(Point, 4326) NOT NULL,
  accuracy_m  REAL        NULL,
  heading_deg REAL        NULL,
  speed_mps   REAL        NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CLAUDE.md §3.4 - GiST on the geometry column.
CREATE INDEX driver_location_history_position_gix ON driver_location_history USING GIST (position);
CREATE INDEX driver_location_history_ride_idx ON driver_location_history (ride_id, recorded_at)
  WHERE ride_id IS NOT NULL;
CREATE INDEX driver_location_history_recorded_at_idx ON driver_location_history (recorded_at);

CREATE TABLE ratings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id    UUID        NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  rater_id   UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ratee_id   UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  score      SMALLINT    NOT NULL,
  comment    TEXT        NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ratings_score_range CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT ratings_no_self CHECK (rater_id <> ratee_id)
);

CREATE UNIQUE INDEX ratings_ride_rater_uq ON ratings (ride_id, rater_id);
CREATE INDEX ratings_ratee_idx ON ratings (ratee_id, created_at DESC);

CREATE TABLE wallet_topups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  admin_id       UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_iqd     BIGINT      NOT NULL,
  transaction_id UUID        NOT NULL,
  reference      TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_topups_amount_positive CHECK (amount_iqd > 0)
);

CREATE INDEX wallet_topups_driver_idx ON wallet_topups (driver_id, created_at DESC);
-- A replayed top-up cannot double-credit: the ledger transaction id is unique.
CREATE UNIQUE INDEX wallet_topups_transaction_uq ON wallet_topups (transaction_id);

CREATE TABLE disputes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     UUID           NOT NULL REFERENCES rides(id) ON DELETE RESTRICT,
  opened_by   UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status      dispute_status NOT NULL DEFAULT 'OPEN',
  reason_code TEXT           NOT NULL,
  description TEXT           NOT NULL DEFAULT '',
  resolved_by UUID           NULL REFERENCES users(id),
  resolution  TEXT           NULL,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ    NULL
);

CREATE INDEX disputes_status_created_idx ON disputes (status, created_at DESC);
CREATE INDEX disputes_ride_idx ON disputes (ride_id);

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The token itself is never stored, only its SHA-256 hash: a database leak
  -- must not hand the reader a set of usable sessions.
  token_hash TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refresh_tokens_hash_uq ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
