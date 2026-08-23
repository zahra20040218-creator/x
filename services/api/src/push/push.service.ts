import type { Clock } from '../common/clock.js';
import type { Logger } from '../common/logger.js';
import type { Database, Queryable } from '../db/db.port.js';
import type { DevicePlatform, PushMessage, PushSender } from './push.port.js';

/**
 * Device registration and push fan-out.
 *
 * The two halves are here together because they share one invariant: a token
 * is only ever a delivery target while it is live, and the only things that
 * end its life are sign-out and FCM telling us it is gone.
 */

export interface PushRequest {
  userId: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface PushSummary {
  delivered: number;
  failed: number;
  revoked: number;
}

export class PushService {
  constructor(
    private readonly db: Database,
    private readonly sender: PushSender,
    private readonly clock: Clock,
    private readonly logger?: Logger,
  ) {}

  /**
   * Register (or re-register) a device.
   *
   * An upsert on the token, not on (user, token). A token identifies a device
   * installation, and if two people share a handset the newer registration has
   * to take it over - otherwise ride offers keep going to whoever registered
   * first. Re-registering also clears `revoked_at`, because a driver signing
   * back in on the same phone is exactly the case that must work.
   */
  async register(userId: string, token: string, platform: DevicePlatform): Promise<void> {
    await this.db.query(
      `INSERT INTO device_tokens (user_id, token, platform, last_seen_at)
       VALUES ($1, $2, $3::device_platform, $4)
       ON CONFLICT (token) DO UPDATE
          SET user_id      = EXCLUDED.user_id,
              platform     = EXCLUDED.platform,
              last_seen_at = EXCLUDED.last_seen_at,
              revoked_at   = NULL`,
      [userId, token, platform, this.clock.now()],
    );
  }

  /**
   * Sign-out, or the app asking to stop.
   *
   * Guarded on `user_id` so one caller cannot unregister another user's
   * device by guessing a token.
   */
  async unregister(userId: string, token: string): Promise<void> {
    await this.db.query(
      `UPDATE device_tokens
          SET revoked_at = $1
        WHERE token = $2 AND user_id = $3 AND revoked_at IS NULL`,
      [this.clock.now(), token, userId],
    );
  }

  /** Every live token for a user. Served by `device_tokens_user_live_idx`. */
  async liveTokensFor(q: Queryable, userId: string): Promise<string[]> {
    const result = await q.query<{ token: string }>(
      `SELECT token FROM device_tokens
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY last_seen_at DESC`,
      [userId],
    );
    return result.rows.map((row) => row.token);
  }

  /**
   * Deliver one notification to every device a user has.
   *
   * Returns a summary rather than throwing. A push that cannot be delivered is
   * not a reason to fail the ride that triggered it - CLAUDE.md §3.2 puts this
   * behind a queue precisely so the request path never waits on it or fails
   * with it.
   */
  async pushToUser(request: PushRequest): Promise<PushSummary> {
    const tokens = await this.liveTokensFor(this.db, request.userId);

    if (tokens.length === 0) {
      // Worth logging: a driver with no live token receives no ride offers at
      // all, and silence here looks identical to "no offers were sent".
      this.logger?.info(
        { event: 'push.no_devices', user_id: request.userId },
        'no registered devices for user',
      );
      return { delivered: 0, failed: 0, revoked: 0 };
    }

    const messages: PushMessage[] = tokens.map((token) => ({
      token,
      title: request.title,
      body: request.body,
      data: request.data,
    }));

    const outcomes = await this.sender.send(messages);

    const invalid = outcomes.filter((o) => o.status === 'invalid').map((o) => o.token);
    if (invalid.length > 0) {
      // Only tokens FCM called permanently invalid. A transient failure keeps
      // its token - revoking on failure would empty the table during an
      // outage and silently stop notifications for everyone afterwards.
      await this.db.query(
        `UPDATE device_tokens SET revoked_at = $1
          WHERE token = ANY($2::text[]) AND revoked_at IS NULL`,
        [this.clock.now(), invalid as never],
      );
    }

    const summary: PushSummary = {
      delivered: outcomes.filter((o) => o.status === 'delivered').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
      revoked: invalid.length,
    };

    if (summary.failed > 0 || summary.revoked > 0) {
      // The token is NOT logged. It is a stable device identifier, which
      // CLAUDE.md §9 puts in the same category as a phone number.
      this.logger?.warn(
        {
          event: 'push.partial',
          user_id: request.userId,
          ...summary,
        },
        'push delivery incomplete',
      );
    }

    return summary;
  }
}
