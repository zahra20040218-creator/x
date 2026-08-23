-- 0006 revocable sessions.
--
-- Security audit S-3: "an admin token cannot be revoked short of rotating
-- JWT_SECRET, which signs everyone out."
--
-- That finding was half right, and the half it got wrong matters. AuthGuard
-- already reloads the user from `users` on EVERY request and refuses an
-- inactive one, so suspending an account already takes effect on that
-- account's next request. What was genuinely missing is narrower and more
-- useful: there is no way to revoke ONE session.
--
-- The consequences of that gap:
--
--   * `POST /auth/logout` revokes the refresh tokens, but the access token the
--     caller is holding stays valid for the rest of its hour. "Log me out"
--     did not log anyone out.
--   * An admin whose laptop is stolen has two options, both bad: deactivate
--     the whole account, or rotate JWT_SECRET and sign out every user of the
--     platform.
--   * Changing something security-sensitive about an account could not
--     invalidate the sessions that existed before the change.
--
-- The fix is deliberately small: a session id, carried in the access token as
-- `sid` and anchored to the refresh-token rows that belong to that session. A
-- session is live while it still has an unrevoked, unexpired refresh token.
-- Revoking is therefore an UPDATE on rows we already had, and "revoke every
-- session for this user" is the `revokeAllForUser` that already existed.
--
-- No new table. Refresh rotation carries the session id forward, so rotating a
-- refresh token does NOT invalidate the access token issued alongside it -
-- which is what a separate row-per-session model would have done wrong.

ALTER TABLE refresh_tokens
  ADD COLUMN session_id UUID NOT NULL DEFAULT gen_random_uuid();

-- Every existing row predates sessions and would otherwise share no session
-- with anything. The DEFAULT above already gave each one its own id, which is
-- the correct interpretation: each existing refresh token is its own session.

-- Serves the guard's per-request liveness check, which runs on EVERY
-- authenticated request and is therefore the most executed query in the
-- system (CLAUDE.md §3.4 - state the index that serves the query).
--
-- Partial on `revoked_at IS NULL` because the check only ever asks about live
-- rows, and a revoked session's rows are dead weight in the index otherwise.
CREATE INDEX refresh_tokens_session_live_idx
  ON refresh_tokens (session_id)
  WHERE revoked_at IS NULL;

-- Serves "revoke every session for this user", used by logout-everywhere and
-- by the post-suspension invalidation.
CREATE INDEX refresh_tokens_user_session_idx
  ON refresh_tokens (user_id, session_id);
