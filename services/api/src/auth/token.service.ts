import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import type { Clock } from '../common/clock.js';
import { UnauthorizedProblem } from '../common/problem.js';
import type { Queryable } from '../db/db.port.js';

/**
 * Platform tokens.
 *
 * Two decisions here are load-bearing:
 *
 *  - **Refresh tokens are stored as a SHA-256 hash, never in plaintext.** A
 *    database leak must not hand the reader a set of usable sessions. Lookup is
 *    by hash, so the plaintext exists only in transit and in client storage.
 *
 *  - **Refresh rotates.** Presenting a refresh token revokes it and issues a
 *    new one, in a single guarded UPDATE. A replayed token affects zero rows
 *    and is rejected - that guard IS the theft-detection mechanism, and
 *    splitting it into SELECT-then-UPDATE would reopen the window it closes.
 *
 *  - **Access tokens carry a session id (`sid`), and a session is revocable.**
 *    Without it, `POST /auth/logout` revoked the refresh tokens and left the
 *    caller's access token working for the rest of its hour - so "log me out"
 *    did not log anyone out, and the only true kill switch was rotating
 *    JWT_SECRET, which signs out every user of the platform. See migration
 *    0006. Rotation deliberately CARRIES THE SESSION FORWARD: refreshing must
 *    not invalidate the access token issued in the same breath.
 */

export type UserRole = 'RIDER' | 'DRIVER' | 'ADMIN';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  role: UserRole;
  /** Session this token belongs to. Revoking the session kills the token. */
  sid: string;
}

export interface ConsumedRefreshToken {
  userId: string;
  sessionId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const ISSUER = 'rideapp';
const AUDIENCE = 'rideapp-clients';

export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly clock: Clock,
    private readonly accessTtlSeconds: number,
    private readonly refreshTtlSeconds: number,
  ) {
    if (secret.length < 32) {
      // A guessable HS256 key means anyone can mint an admin token.
      throw new Error('JWT secret must be at least 32 characters.');
    }
    this.key = new TextEncoder().encode(secret);
  }

  async issueAccessToken(userId: string, role: UserRole, sessionId: string): Promise<string> {
    const now = Math.floor(this.clock.nowMs() / 1_000);
    return new SignJWT({ role, sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt(now)
      .setExpirationTime(now + this.accessTtlSeconds)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: this.clock.now(),
      });

      const role = payload['role'];
      const sid = payload['sid'];

      // `sid` is REQUIRED, so a token minted before migration 0006 is refused
      // rather than quietly accepted as unrevocable. Fail closed: the whole
      // point of this claim is that a session can be killed, and honouring
      // tokens that predate it would leave exactly the hole being closed.
      // Cost of the strictness: everyone signs in once after deploying it.
      if (typeof payload.sub !== 'string' || !isRole(role) || typeof sid !== 'string') {
        throw new UnauthorizedProblem('Malformed token claims.');
      }
      return { ...payload, sub: payload.sub, role, sid };
    } catch (error) {
      if (error instanceof UnauthorizedProblem) throw error;
      // Deliberately uniform: distinguishing "expired" from "bad signature"
      // tells an attacker which half of a forged token was wrong.
      throw new UnauthorizedProblem('Invalid or expired token.');
    }
  }

  /** Opaque random string. Not a JWT: it carries no claims and is revocable. */
  generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async storeRefreshToken(
    q: Queryable,
    userId: string,
    token: string,
    sessionId: string,
  ): Promise<void> {
    const expiresAt = new Date(this.clock.nowMs() + this.refreshTtlSeconds * 1_000);
    await q.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, this.hashRefreshToken(token), expiresAt, sessionId],
    );
  }

  /** A new session identifier. Opaque; only ever compared for equality. */
  generateSessionId(): string {
    return randomUUID();
  }

  /**
   * Is this session still usable?
   *
   * A session is live while it has at least one unrevoked, unexpired refresh
   * token. Rotation keeps exactly one such row, logout revokes them all.
   *
   * Served by `refresh_tokens_session_live_idx` (partial, `revoked_at IS
   * NULL`) - CLAUDE.md §3.4. This runs on every authenticated request, so it
   * is the most executed query in the system.
   */
  async isSessionLive(q: Queryable, sessionId: string): Promise<boolean> {
    const result = await q.query<{ ok: boolean }>(
      `SELECT TRUE AS ok
         FROM refresh_tokens
        WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > $2
        LIMIT 1`,
      [sessionId, this.clock.now()],
    );
    return result.rows.length > 0;
  }

  /**
   * Consume a refresh token, returning the user it belonged to.
   *
   * Guarded on `revoked_at IS NULL` and on expiry in the UPDATE itself, so a
   * replay affects zero rows.
   */
  async consumeRefreshToken(q: Queryable, token: string): Promise<ConsumedRefreshToken> {
    const result = await q.query<{ user_id: string; session_id: string }>(
      `UPDATE refresh_tokens
          SET revoked_at = $1
        WHERE token_hash = $2 AND revoked_at IS NULL AND expires_at > $1
        RETURNING user_id, session_id`,
      [this.clock.now(), this.hashRefreshToken(token)],
    );

    const row = result.rows[0];
    if (!row) {
      throw new UnauthorizedProblem('Refresh token is invalid, expired, or already used.');
    }
    return { userId: row.user_id, sessionId: row.session_id };
  }

  async revokeAllForUser(q: Queryable, userId: string): Promise<number> {
    const result = await q.query(
      `UPDATE refresh_tokens SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`,
      [this.clock.now(), userId],
    );
    return result.rowCount;
  }

  /**
   * @param sessionId continue an existing session (refresh rotation). Omit to
   *   start a new one (fresh sign-in).
   */
  async issuePair(
    q: Queryable,
    userId: string,
    role: UserRole,
    sessionId?: string,
  ): Promise<TokenPair> {
    const session = sessionId ?? this.generateSessionId();
    const refreshToken = this.generateRefreshToken();
    await this.storeRefreshToken(q, userId, refreshToken, session);
    return {
      accessToken: await this.issueAccessToken(userId, role, session),
      refreshToken,
      expiresIn: this.accessTtlSeconds,
    };
  }
}

function isRole(value: unknown): value is UserRole {
  return value === 'RIDER' || value === 'DRIVER' || value === 'ADMIN';
}
