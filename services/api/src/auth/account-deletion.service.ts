import { ConflictProblem, NotFoundProblem } from '../common/problem.js';
import type { Clock } from '../common/clock.js';
import type { Database, Queryable } from '../db/db.port.js';

/**
 * The one thing this service needs from the session layer.
 *
 * A port rather than `TokenService` itself, matching how `Database`, `Clock`
 * and `RedisPort` are declared. `TokenService` satisfies it structurally, and
 * a test does not have to construct a JWT signer with a 32-character secret to
 * assert that credentials are revoked before anything is erased.
 */
export interface SessionRevoker {
  revokeAllForUser(q: Queryable, userId: string): Promise<number>;
}

/**
 * Erasing an account, at the user's own request.
 *
 * Google Play requires an in-app path to account deletion, and there was none -
 * which blocks publication regardless of how finished anything else is.
 *
 * ## It is anonymisation, and it has to be
 *
 * Eighteen foreign keys point at `users(id)`, every one `ON DELETE RESTRICT`,
 * and `ledger_entries` is append-only with database triggers behind it
 * (CLAUDE.md §6.3). A hard DELETE is not merely inadvisable here, it is
 * refused by the schema - and correctly, because a completed ride and its
 * ledger rows must not come to reference a person who no longer exists.
 *
 * So every piece of personal data is erased and every credential severed, while
 * the financial and operational record survives pointing at an anonymous id.
 * Play permits retaining what is required for legitimate financial purposes
 * when it is disclosed; `docs/PLAY_LISTING.md` discloses it.
 *
 * ## What is refused, and why each one
 *
 * A live ride. Erasing a rider mid-trip leaves a driver carrying a passenger
 * the system cannot name; erasing a driver mid-trip leaves a rider in a car
 * nobody is tracking. Neither is recoverable by an apology, so the request is
 * refused with the ride id and the person is asked to finish or cancel first.
 *
 * A positive wallet balance is NOT refused, and that is deliberate. It is money
 * the platform owes the driver, and blocking deletion until they collect turns
 * a privacy right into a debt-collection lever. The balance stays on the ledger
 * against the anonymised id, and an operator can still settle it - the
 * `wallet_topups` and ledger rows keep the audit trail intact.
 */
export class AccountDeletionService {
  constructor(
    private readonly db: Database,
    private readonly tokens: SessionRevoker,
    private readonly clock: Clock,
  ) {}

  /**
   * Erase this account. Idempotent: deleting an already-deleted account is a
   * no-op rather than an error, because a client retrying after a dropped
   * response must not be told it failed.
   */
  async deleteOwnAccount(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const user = await tx.query<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM users WHERE id = $1`,
        [userId],
      );
      const row = user.rows[0];
      if (!row) throw new NotFoundProblem('Account');
      if (row.deleted_at !== null) return;

      // A live ride, as either party. `rides_one_active_per_driver_uq` and the
      // rider equivalent mean there is at most one, but both sides are checked
      // because a person can be a rider on one and a driver on another.
      const active = await tx.query<{ id: string }>(
        `SELECT id FROM rides
          WHERE (rider_id = $1 OR driver_id = $1)
            AND status IN ('REQUESTED', 'OFFERED', 'ACCEPTED',
                           'DRIVER_ARRIVED', 'IN_PROGRESS')
          LIMIT 1`,
        [userId],
      );
      const live = active.rows[0];
      if (live) {
        throw new ConflictProblem(
          'Finish or cancel the ride in progress before deleting this account.',
          { rideId: live.id },
        );
      }

      // Order matters below. Credentials go first, so that a request racing
      // this transaction cannot authenticate against the account halfway
      // through being erased.
      await this.tokens.revokeAllForUser(tx, userId);

      // Device tokens, or the next person to sign in on this handset would
      // receive the deleted user's notifications.
      await tx.query(`DELETE FROM device_tokens WHERE user_id = $1`, [userId]);

      // The driver's movement history. Pure personal data with no financial
      // meaning - unlike a ride, nothing references it and nothing needs it
      // once the account is gone, so it is genuinely deleted rather than
      // anonymised. The 90-day retention sweep would eventually have taken it;
      // a deletion request should not have to wait 90 days.
      await tx.query(`DELETE FROM driver_location_history WHERE driver_id = $1`, [userId]);

      // The tombstone. `+9640…` satisfies `users_phone_e164_format` and can
      // never collide with a real subscriber, because Iraqi mobile numbers
      // always carry a 7 after the country code. The digits come from a
      // sequence rather than a hash, because a hash collision would fail the
      // unique index mid-deletion on a user who has already been told this
      // worked.
      //
      // `firebase_uid` is nulled rather than tombstoned: it is UNIQUE only
      // WHERE NOT NULL, and leaving it set would let the same Firebase identity
      // resolve back to this row on the next sign-in.
      await tx.query(
        `UPDATE users
            SET phone_e164  = '+9640' || lpad(nextval('deleted_account_seq')::text, 9, '0'),
                display_name = 'حساب محذوف',
                firebase_uid = NULL,
                is_active    = FALSE,
                deleted_at   = $2
          WHERE id = $1`,
        [userId, this.clock.now()],
      );

      // Taken offline in the same transaction. A deleted driver left in the
      // Redis geo set would keep receiving dispatches; presence is swept
      // separately, but the database must not disagree in the meantime.
      await tx.query(
        `UPDATE drivers SET availability = 'OFFLINE', updated_at = now()
          WHERE user_id = $1`,
        [userId],
      );
    });
  }
}
