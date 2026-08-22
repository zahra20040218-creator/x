import { ForbiddenProblem, UnauthorizedProblem } from '../common/problem.js';
import type { Database, Queryable } from '../db/db.port.js';
import type { FirebaseVerifier } from './firebase-verifier.js';
import { normalizeIraqiPhone, InvalidPhoneNumberError } from './phone.js';
import type { TokenPair, TokenService, UserRole } from './token.service.js';

/**
 * Sign-in, refresh and sign-out.
 *
 * The shape of sign-up differs by role on purpose:
 *
 *  - A **RIDER** is created on first sign-in. Anyone with an Iraqi mobile can
 *    be a rider.
 *  - A **DRIVER** is NOT. CLAUDE.md §2 says admins create drivers manually in
 *    v1 and there is no KYC flow, so a driver who does not already exist gets
 *    403 rather than an account. Auto-creating one here would be a silent
 *    scope expansion that puts unvetted people behind the wheel.
 *  - An **ADMIN** is never created through this path at all.
 */

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  displayName: string;
  phone: string;
}

export interface AuthSession extends TokenPair {
  user: AuthenticatedUser;
}

interface UserRow {
  id: string;
  role: UserRole;
  display_name: string;
  phone_e164: string;
  is_active: boolean;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly firebase: FirebaseVerifier,
    private readonly tokens: TokenService,
  ) {}

  async verifyOtp(input: {
    firebaseIdToken: string;
    role: 'RIDER' | 'DRIVER';
    displayName?: string | undefined;
  }): Promise<AuthSession> {
    const identity = await this.firebase.verify(input.firebaseIdToken);

    // Firebase returns E.164 already, but it is still third-party input and
    // still goes through the same normaliser as anything a human typed -
    // otherwise two spellings of one number become two accounts.
    let phone: string;
    try {
      phone = normalizeIraqiPhone(identity.phoneNumber);
    } catch (error) {
      if (error instanceof InvalidPhoneNumberError) {
        throw new ForbiddenProblem('Only Iraqi mobile numbers are supported.');
      }
      throw error;
    }

    return this.db.transaction(async (tx) => {
      const existing = await this.findByPhoneAndRole(tx, phone, input.role);

      if (existing) {
        if (!existing.is_active) {
          throw new ForbiddenProblem('This account has been deactivated.');
        }
        await this.linkFirebaseUid(tx, existing.id, identity.uid);
        return this.sessionFor(tx, existing);
      }

      if (input.role === 'DRIVER') {
        // CLAUDE.md §2 - no driver self-signup, no KYC upload in v1.
        throw new ForbiddenProblem(
          'No driver account exists for this number. An administrator must create it first.',
        );
      }

      const created = await this.createRider(
        tx,
        phone,
        input.displayName?.trim() || 'راكب',
        identity.uid,
      );
      return this.sessionFor(tx, created);
    });
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    return this.db.transaction(async (tx) => {
      const userId = await this.tokens.consumeRefreshToken(tx, refreshToken);

      const result = await tx.query<UserRow>(
        `SELECT id, role, display_name, phone_e164, is_active FROM users WHERE id = $1`,
        [userId],
      );
      const user = result.rows[0];
      if (!user || !user.is_active) {
        throw new UnauthorizedProblem('Account is no longer active.');
      }

      return this.sessionFor(tx, user);
    });
  }

  async logout(userId: string): Promise<void> {
    await this.tokens.revokeAllForUser(this.db, userId);
  }

  async loadUser(userId: string): Promise<AuthenticatedUser> {
    const result = await this.db.query<UserRow>(
      `SELECT id, role, display_name, phone_e164, is_active FROM users WHERE id = $1`,
      [userId],
    );
    const user = result.rows[0];
    if (!user || !user.is_active) throw new UnauthorizedProblem('Account is no longer active.');
    return toAuthenticatedUser(user);
  }

  // -------------------------------------------------------------------------

  private async findByPhoneAndRole(
    q: Queryable,
    phone: string,
    role: UserRole,
  ): Promise<UserRow | undefined> {
    const result = await q.query<UserRow>(
      `SELECT id, role, display_name, phone_e164, is_active
         FROM users WHERE phone_e164 = $1 AND role = $2`,
      [phone, role],
    );
    return result.rows[0];
  }

  private async linkFirebaseUid(q: Queryable, userId: string, uid: string): Promise<void> {
    await q.query(
      `UPDATE users SET firebase_uid = $1, updated_at = now()
        WHERE id = $2 AND (firebase_uid IS NULL OR firebase_uid <> $1)`,
      [uid, userId],
    );
  }

  private async createRider(
    q: Queryable,
    phone: string,
    displayName: string,
    uid: string,
  ): Promise<UserRow> {
    const result = await q.query<UserRow>(
      `INSERT INTO users (role, phone_e164, display_name, firebase_uid)
       VALUES ('RIDER', $1, $2, $3)
       RETURNING id, role, display_name, phone_e164, is_active`,
      [phone, displayName, uid],
    );
    const user = result.rows[0]!;
    await q.query(`INSERT INTO riders (user_id) VALUES ($1)`, [user.id]);
    return user;
  }

  private async sessionFor(q: Queryable, user: UserRow): Promise<AuthSession> {
    const pair = await this.tokens.issuePair(q, user.id, user.role);
    return { ...pair, user: toAuthenticatedUser(user) };
  }
}

function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    role: row.role,
    displayName: row.display_name,
    // Only ever the caller's OWN phone. The counterparty representation
    // (PublicUser in the API contract) has no phone field at all.
    phone: row.phone_e164,
  };
}
