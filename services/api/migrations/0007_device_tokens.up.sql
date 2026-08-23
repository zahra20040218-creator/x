-- 0007 device tokens.
--
-- Push delivery had no destination. The backend enqueued push jobs, the worker
-- logged them and dropped them, and there was no table in which a device token
-- could have been stored even if the sender had existed.
--
-- The practical consequence: ride offers expire in 15 seconds, so a driver
-- whose phone is in their pocket receives nothing and earns nothing. Drivers
-- had to sit watching a foregrounded app.

CREATE TYPE device_platform AS ENUM ('ANDROID', 'IOS');

CREATE TABLE device_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE, unlike most foreign keys here. A device token is not a record of
  -- anything that happened - it is a routing address. When the account goes,
  -- the address is meaningless, and keeping it would leave a token that could
  -- still be selected for delivery.
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  token        TEXT        NOT NULL,
  platform     device_platform NOT NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Refreshed on every re-registration. The apps re-register on launch, so
  -- this doubles as "when did we last see this install".
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when FCM reports the token as permanently invalid, or on sign-out.
  -- Soft rather than a DELETE so a token that comes back can be distinguished
  -- from one that was never seen.
  revoked_at   TIMESTAMPTZ NULL,

  CONSTRAINT device_tokens_token_len CHECK (char_length(token) BETWEEN 1 AND 4096)
);

-- UNIQUE ON THE TOKEN ALONE, not on (user_id, token).
--
-- A token identifies a device installation, not a person. Two people sharing a
-- handset - which is common - must not both be registered against it, or the
-- second one's ride offers would be delivered to a phone the first is holding.
-- Registration therefore REASSIGNS the token, and this index is what makes
-- that an upsert rather than a duplicate.
CREATE UNIQUE INDEX device_tokens_token_uq ON device_tokens (token);

-- Serves the only hot query: "every live token for this user", run on every
-- push. Partial, because a revoked token is never a delivery target
-- (CLAUDE.md §3.4).
CREATE INDEX device_tokens_user_live_idx
  ON device_tokens (user_id)
  WHERE revoked_at IS NULL;
