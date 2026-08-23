-- Reverses 0006.
--
-- Dropping `session_id` loses which access tokens belonged together, so every
-- outstanding access token becomes unverifiable against a session and callers
-- must sign in again. That is a session reset, not data loss: refresh_tokens
-- is a session store, and nothing here is a financial or audit record.

DROP INDEX IF EXISTS refresh_tokens_user_session_idx;
DROP INDEX IF EXISTS refresh_tokens_session_live_idx;

ALTER TABLE refresh_tokens
  DROP COLUMN IF EXISTS session_id;
