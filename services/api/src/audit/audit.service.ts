import { currentRequestContext, type Logger } from '../common/logger.js';
import type { Queryable } from '../db/db.port.js';

/**
 * Admin audit trail.
 *
 * Brief §16: every sensitive admin action emits an event carrying at least
 * `adminId, action, timestamp, correlationId, target, result`.
 *
 * Two design rules, both learned from how audit logs usually fail:
 *
 * 1. **Failures are recorded too.** A log that only contains successes cannot
 *    answer "did someone try and get refused?" — which is the question an
 *    incident actually starts with. `recordFailure` exists for that, and the
 *    controllers call it on the rejection paths.
 *
 * 2. **Writing the audit row must never break the action.** If the audit
 *    INSERT fails inside the caller's transaction it would roll back a
 *    legitimate wallet top-up. So a failure here is logged loudly and
 *    swallowed. That is a deliberate trade: losing one audit row is bad,
 *    losing the operator's money movement is worse, and a silent swallow is
 *    prevented by the `audit.write_failed` log line.
 */

export type AuditResult = 'SUCCESS' | 'FAILURE';

/**
 * The verbs. A closed set rather than free strings, so a typo is a compile
 * error and the admin UI can filter on values that actually exist.
 */
export const AUDIT_ACTIONS = {
  driverCreate: 'driver.create',
  driverUpdate: 'driver.update',
  // Its own verb: "who approved this licence, and when" is the question asked
  // after an incident, and it should not require reading metadata to answer.
  documentVerify: 'document.verify',
  documentReject: 'document.reject',
  driverSuspend: 'driver.suspend',
  driverUnsuspend: 'driver.unsuspend',
  walletTopUp: 'wallet.topup',
  // Its own verb rather than a config or wallet event: this is the row that
  // answers "who sold this driver a period, for how much, and when" - the
  // exact question a billing dispute opens with.
  subscriptionGrant: 'subscription.grant',
  disputeResolve: 'dispute.resolve',
  configUpdate: 'config.update',
  rideCancelByAdmin: 'ride.cancel_by_admin',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  actorId: string;
  actorRole: 'RIDER' | 'DRIVER' | 'ADMIN';
  action: AuditAction;
  targetType: string;
  targetId?: string | null;
  result: AuditResult;
  /** Amounts and ids only. Never a phone number, a name, or a coordinate. */
  metadata?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly logger?: Logger) {}

  async record(q: Queryable, entry: AuditEntry): Promise<void> {
    // Ties the row to every log line the same request emitted (CLAUDE.md §9).
    const correlationId = currentRequestContext()?.requestId ?? 'no-request-context';

    try {
      await q.query(
        `INSERT INTO audit_log
           (actor_id, actor_role, action, target_type, target_id,
            result, correlation_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.actorId,
          entry.actorRole,
          entry.action,
          entry.targetType,
          entry.targetId ?? null,
          entry.result,
          correlationId,
          JSON.stringify(scrub(entry.metadata ?? {})),
        ],
      );
    } catch (error) {
      // Never let auditing break the audited action. See the class comment.
      this.logger?.error(
        {
          event: 'audit.write_failed',
          action: entry.action,
          target_type: entry.targetType,
          err: error,
        },
        'FAILED TO WRITE AUDIT ROW - the action itself still succeeded',
      );
    }
  }

  /** Convenience for the rejection paths. */
  async recordFailure(
    q: Queryable,
    entry: Omit<AuditEntry, 'result'> & { reason: string },
  ): Promise<void> {
    const { reason, ...rest } = entry;
    await this.record(q, {
      ...rest,
      result: 'FAILURE',
      metadata: { ...(rest.metadata ?? {}), reason },
    });
  }

  async listForTarget(
    q: Queryable,
    targetType: string,
    targetId: string,
    limit = 50,
  ): Promise<AuditRow[]> {
    const result = await q.query<AuditRow>(
      `SELECT id, actor_id, actor_role, action, target_type, target_id,
              result, correlation_id, metadata, created_at
         FROM audit_log
        WHERE target_type = $1 AND target_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [targetType, targetId, Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows;
  }

  async listForActor(q: Queryable, actorId: string, limit = 50): Promise<AuditRow[]> {
    const result = await q.query<AuditRow>(
      `SELECT id, actor_id, actor_role, action, target_type, target_id,
              result, correlation_id, metadata, created_at
         FROM audit_log
        WHERE actor_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [actorId, Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows;
  }
}

export interface AuditRow {
  id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string | null;
  result: AuditResult;
  correlation_id: string;
  metadata: unknown;
  created_at: Date;
}

/**
 * Keys that must never reach the audit metadata.
 *
 * The audit log is read by operators and exported for disputes, so it is a
 * plausible route for PII to escape (CLAUDE.md §9). The logger redacts its own
 * output; this redacts what is written to the database, which the logger never
 * sees.
 */
const FORBIDDEN_KEYS = new Set([
  'phone',
  'phone_e164',
  'phoneE164',
  'displayName',
  'display_name',
  'name',
  'lat',
  'lng',
  'latitude',
  'longitude',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
]);

export function scrub(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_KEYS.has(key)) {
      out[key] = '[redacted]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = scrub(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
