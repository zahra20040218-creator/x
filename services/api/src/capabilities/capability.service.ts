import type { Clock } from '../common/clock.js';
import type { Database, Queryable } from '../db/db.port.js';
import type { DriverComplianceService } from '../compliance/driver-compliance.service.js';

/**
 * What this user is allowed to do, decided on the server.
 *
 * ## Why this exists
 *
 * ALY ships as one app with a Rider mode and a Driver mode (CLAUDE.md §1.1).
 * The moment those live in one binary, "which mode am I in" stops being a
 * navigation question and becomes the system's main authorisation boundary: a
 * rider who flips a flag must not be able to receive dispatches, see other
 * people's rides, or draw earnings.
 *
 * The failure mode to design against is not a malicious rider reverse
 * engineering the app. It is far more ordinary - a screen that hides the driver
 * tab, an endpoint that assumes anyone calling it must have seen that tab, and
 * a year later nobody remembers the endpoint was never checked. That is exactly
 * how `accept` was authorising nobody before D-14: the guard was a screen, and
 * the screen was not a guard.
 *
 * So there is one answer to "may this user drive", it is computed here, and
 * every caller asks it rather than re-deriving it. The endpoint that serves it
 * to the app returns the same object the server enforces with. If the two ever
 * disagreed, the app would be showing a promise the server will not keep.
 *
 * ## The rules, and where each fact lives
 *
 * | Requirement | Source |
 * |---|---|
 * | account not banned | `users.is_active` |
 * | driver row exists | `drivers` |
 * | approved by an administrator | `drivers.approval_status` |
 * | not suspended | `drivers.is_suspended` |
 * | documents present and unexpired | `driver_documents`, via DriverComplianceService |
 * | subscription valid, if required | `driver_subscriptions` + `platform_config` |
 *
 * None of those are duplicated here. This joins them; it does not restate them.
 *
 * ## Every reason, not the first one
 *
 * `reasons` is a list because a driver blocked for three reasons who fixes one
 * and is still blocked has learned nothing. Returning the full set lets the app
 * show a checklist, which is the only version of this screen that a driver can
 * act on.
 */

/** The one machine-readable reason a mode is unavailable. */
export type CapabilityBlocker =
  | 'ACCOUNT_DISABLED'
  | 'NOT_A_DRIVER'
  | 'APPROVAL_PENDING'
  | 'APPROVAL_REJECTED'
  | 'SUSPENDED'
  | 'DOCUMENTS_INCOMPLETE'
  | 'SUBSCRIPTION_REQUIRED';

export interface DriverCapability {
  /** True only when `blockers` is empty. Never set independently. */
  readonly allowed: boolean;
  readonly blockers: readonly CapabilityBlocker[];
  /** Present when SUSPENDED, so the app can show what the driver was told. */
  readonly suspendedReason: string | null;
  /** Present when DOCUMENTS_INCOMPLETE. */
  readonly missingDocuments: readonly string[];
  readonly expiredDocuments: readonly string[];
  readonly rejectedDocuments: readonly string[];
  /** Present when a subscription exists, whether or not it is required. */
  readonly subscriptionExpiresAt: Date | null;
}

export interface Capabilities {
  readonly userId: string;
  /**
   * Rider mode is available to any account that is not disabled.
   *
   * There is no "rider approval": refusing to let a banned account ride is the
   * whole of the rider rule, and inventing more would be inventing policy.
   */
  readonly canRide: boolean;
  readonly driver: DriverCapability;
}

interface UserRow {
  is_active: boolean;
}

interface DriverRow {
  approval_status: 'PENDING' | 'APPROVED' | 'REJECTED';
  is_suspended: boolean;
  suspended_reason: string | null;
}

interface SubscriptionRow {
  expires_at: Date;
}

export class CapabilityService {
  constructor(
    private readonly db: Database,
    private readonly compliance: DriverComplianceService,
    private readonly clock: Clock,
    /**
     * Whether a valid subscription is required to drive.
     *
     * A function, not a boolean, for the same reason the commission rate is
     * config and not a constant (CLAUDE.md §6.5): an owner turns this on in the
     * admin panel, and it must take effect without a deploy.
     */
    private readonly subscriptionRequired: () => Promise<boolean>,
  ) {}

  /**
   * The authoritative answer.
   *
   * `q` is a Queryable rather than the injected Database so a caller inside a
   * transaction gets the transaction's view. A gate that checks approval on a
   * different snapshot from the write it guards is a race with a longer name.
   */
  async evaluate(userId: string, q: Queryable = this.db): Promise<Capabilities> {
    const user = await q.query<UserRow>(
      `SELECT is_active FROM users WHERE id = $1`,
      [userId],
    );
    const account = user.rows[0];

    // An account that does not exist and one that is disabled get the same
    // answer. Distinguishing them would confirm which user ids are real.
    if (!account || !account.is_active) {
      return {
        userId,
        canRide: false,
        driver: blocked(['ACCOUNT_DISABLED']),
      };
    }

    const driver = await q.query<DriverRow>(
      `SELECT approval_status, is_suspended, suspended_reason
         FROM drivers WHERE user_id = $1`,
      [userId],
    );
    const profile = driver.rows[0];

    if (!profile) {
      // A rider, which is the ordinary case. Not an error.
      return { userId, canRide: true, driver: blocked(['NOT_A_DRIVER']) };
    }

    const blockers: CapabilityBlocker[] = [];

    if (profile.approval_status === 'PENDING') blockers.push('APPROVAL_PENDING');
    if (profile.approval_status === 'REJECTED') blockers.push('APPROVAL_REJECTED');
    if (profile.is_suspended) blockers.push('SUSPENDED');

    // Documents. No-op unless an owner has configured a policy; the service
    // does not even run a query when the required list is empty.
    const verdict = await this.compliance.evaluate(q, userId);
    if (!verdict.compliant) blockers.push('DOCUMENTS_INCOMPLETE');

    // Subscription. The row is read either way so the app can show an expiry
    // date before the policy is switched on - a driver should be able to see
    // what they bought whether or not it currently gates anything.
    const subscription = await q.query<SubscriptionRow>(
      `SELECT expires_at FROM driver_subscriptions
        WHERE driver_id = $1 AND status = 'ACTIVE'
        ORDER BY expires_at DESC
        LIMIT 1`,
      [userId],
    );
    const expiresAt = subscription.rows[0]?.expires_at ?? null;

    if (await this.subscriptionRequired()) {
      // Expiry is compared here rather than trusted from `status`, for the same
      // reason 0010 refuses a stored EXPIRED document state: a status column
      // needs a sweep to keep it true, and between two runs of that sweep it is
      // wrong - which here means a driver working on a lapsed subscription.
      const valid = expiresAt !== null && expiresAt.getTime() > this.clock.now().getTime();
      if (!valid) blockers.push('SUBSCRIPTION_REQUIRED');
    }

    return {
      userId,
      canRide: true,
      driver: {
        allowed: blockers.length === 0,
        blockers,
        suspendedReason: profile.is_suspended ? profile.suspended_reason : null,
        missingDocuments: verdict.missing,
        expiredDocuments: verdict.expired,
        rejectedDocuments: verdict.rejected,
        subscriptionExpiresAt: expiresAt,
      },
    };
  }

  /**
   * `evaluate`, but it throws the 403 the API contract specifies.
   *
   * Callers that guard a driver action use this, so the check and the refusal
   * cannot drift apart - the pattern `RideClaimService.claimOrThrow` already
   * uses for the same reason.
   */
  async requireDriver(userId: string, q: Queryable = this.db): Promise<Capabilities> {
    const capabilities = await this.evaluate(userId, q);
    if (!capabilities.driver.allowed) {
      throw new DriverModeUnavailableError(capabilities.driver);
    }
    return capabilities;
  }
}

/** A driver-scoped action attempted by someone who may not currently drive. */
export class DriverModeUnavailableError extends Error {
  constructor(readonly capability: DriverCapability) {
    super(`driver mode unavailable: ${capability.blockers.join(', ')}`);
    this.name = 'DriverModeUnavailableError';
  }
}

function blocked(blockers: CapabilityBlocker[]): DriverCapability {
  return {
    allowed: false,
    blockers,
    suspendedReason: null,
    missingDocuments: [],
    expiredDocuments: [],
    rejectedDocuments: [],
    subscriptionExpiresAt: null,
  };
}
