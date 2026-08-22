import { beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../../src/auth/auth.service.js';
import { FakeFirebaseVerifier } from '../../src/auth/firebase-verifier.js';
import { TokenService } from '../../src/auth/token.service.js';
import { FakeClock } from '../../src/common/clock.js';
import { ForbiddenProblem, UnauthorizedProblem } from '../../src/common/problem.js';
import { FakeDatabase } from '../fakes/fake-database.js';

const SECRET = 'a-test-secret-that-is-long-enough-32';
const RIDER_PHONE = '+9647701234567';
const DRIVER_PHONE = '+9647709998888';

describe('TokenService', () => {
  let clock: FakeClock;
  let db: FakeDatabase;
  let tokens: TokenService;

  beforeEach(() => {
    clock = new FakeClock();
    db = new FakeDatabase();
    tokens = new TokenService(SECRET, clock, 3_600, 2_592_000);
  });

  // A guessable HS256 key means anyone can mint an admin token.
  it('refuses a short secret at construction', () => {
    expect(() => new TokenService('too-short', clock, 3_600, 60)).toThrow(/at least 32/);
  });

  describe('access tokens', () => {
    it('round-trips subject and role', async () => {
      const token = await tokens.issueAccessToken('user-1', 'DRIVER');
      const claims = await tokens.verifyAccessToken(token);

      expect(claims.sub).toBe('user-1');
      expect(claims.role).toBe('DRIVER');
    });

    it('rejects a token after it expires', async () => {
      const token = await tokens.issueAccessToken('user-1', 'RIDER');
      clock.advanceSeconds(3_601);

      await expect(tokens.verifyAccessToken(token)).rejects.toThrow(UnauthorizedProblem);
    });

    it('accepts a token right up to expiry', async () => {
      const token = await tokens.issueAccessToken('user-1', 'RIDER');
      clock.advanceSeconds(3_500);

      await expect(tokens.verifyAccessToken(token)).resolves.toBeDefined();
    });

    // The whole point of signing.
    it('rejects a token signed with a different secret', async () => {
      const attacker = new TokenService('a-different-secret-also-long-enough', clock, 3_600, 60);
      const forged = await attacker.issueAccessToken('user-1', 'ADMIN');

      await expect(tokens.verifyAccessToken(forged)).rejects.toThrow(UnauthorizedProblem);
    });

    it('rejects a tampered token', async () => {
      const token = await tokens.issueAccessToken('user-1', 'RIDER');
      const [header, payload, signature] = token.split('.');
      const tampered = `${header}.${payload}.${signature!.slice(0, -2)}xy`;

      await expect(tokens.verifyAccessToken(tampered)).rejects.toThrow(UnauthorizedProblem);
    });

    it.each(['', 'not.a.jwt', 'garbage'])('rejects the malformed token %p', async (token) => {
      await expect(tokens.verifyAccessToken(token)).rejects.toThrow(UnauthorizedProblem);
    });

    // Distinguishing "expired" from "bad signature" tells an attacker which
    // half of a forged token was wrong.
    it('gives the same message for expired and forged tokens', async () => {
      const expired = await tokens.issueAccessToken('user-1', 'RIDER');
      clock.advanceSeconds(3_601);

      const attacker = new TokenService('a-different-secret-also-long-enough', clock, 3_600, 60);
      const forged = await attacker.issueAccessToken('user-1', 'ADMIN');

      const expiredError = await tokens.verifyAccessToken(expired).catch((e: Error) => e.message);
      const forgedError = await tokens.verifyAccessToken(forged).catch((e: Error) => e.message);

      expect(expiredError).toBe(forgedError);
    });
  });

  describe('refresh tokens', () => {
    it('issues a pair and consumes the refresh token once', async () => {
      const pair = await tokens.issuePair(db, 'user-1', 'RIDER');

      expect(await tokens.consumeRefreshToken(db, pair.refreshToken)).toBe('user-1');
    });

    // Rotation: a replayed token affects zero rows and is rejected. That guard
    // is the theft-detection mechanism.
    it('rejects a refresh token replayed after use', async () => {
      const pair = await tokens.issuePair(db, 'user-1', 'RIDER');
      await tokens.consumeRefreshToken(db, pair.refreshToken);

      await expect(tokens.consumeRefreshToken(db, pair.refreshToken)).rejects.toThrow(
        /invalid, expired, or already used/,
      );
    });

    it('rejects an unknown refresh token', async () => {
      await expect(tokens.consumeRefreshToken(db, 'never-issued')).rejects.toThrow(
        UnauthorizedProblem,
      );
    });

    it('rejects an expired refresh token', async () => {
      const pair = await tokens.issuePair(db, 'user-1', 'RIDER');
      clock.advanceSeconds(2_592_001);

      await expect(tokens.consumeRefreshToken(db, pair.refreshToken)).rejects.toThrow(
        UnauthorizedProblem,
      );
    });

    // A database leak must not hand the reader a set of usable sessions.
    it('never stores the refresh token in plaintext', async () => {
      const pair = await tokens.issuePair(db, 'user-1', 'RIDER');

      const stored = JSON.stringify(db.rows('refresh_tokens'));
      expect(stored).not.toContain(pair.refreshToken);
      expect(stored).toContain(tokens.hashRefreshToken(pair.refreshToken));
    });

    it('issues a distinct token every time', async () => {
      const issued = new Set<string>();
      for (let i = 0; i < 50; i++) issued.add(tokens.generateRefreshToken());
      expect(issued.size).toBe(50);
    });

    it('revokes every live token for a user on logout', async () => {
      const first = await tokens.issuePair(db, 'user-1', 'RIDER');
      const second = await tokens.issuePair(db, 'user-1', 'RIDER');

      expect(await tokens.revokeAllForUser(db, 'user-1')).toBe(2);

      await expect(tokens.consumeRefreshToken(db, first.refreshToken)).rejects.toThrow();
      await expect(tokens.consumeRefreshToken(db, second.refreshToken)).rejects.toThrow();
    });

    it('does not revoke another user tokens', async () => {
      const mine = await tokens.issuePair(db, 'user-1', 'RIDER');
      await tokens.issuePair(db, 'user-2', 'RIDER');

      await tokens.revokeAllForUser(db, 'user-2');

      await expect(tokens.consumeRefreshToken(db, mine.refreshToken)).resolves.toBe('user-1');
    });
  });
});

describe('AuthService', () => {
  let clock: FakeClock;
  let db: FakeDatabase;
  let firebase: FakeFirebaseVerifier;
  let auth: AuthService;

  beforeEach(() => {
    clock = new FakeClock();
    db = new FakeDatabase();
    firebase = new FakeFirebaseVerifier();
    auth = new AuthService(
      db,
      firebase,
      new TokenService(SECRET, clock, 3_600, 2_592_000),
    );

    firebase.register('rider-token', { uid: 'fb-rider', phoneNumber: RIDER_PHONE });
    firebase.register('driver-token', { uid: 'fb-driver', phoneNumber: DRIVER_PHONE });
  });

  describe('rider sign-in', () => {
    it('creates a rider on first sign-in', async () => {
      const session = await auth.verifyOtp({
        firebaseIdToken: 'rider-token',
        role: 'RIDER',
        displayName: 'أحمد',
      });

      expect(session.user.role).toBe('RIDER');
      expect(session.user.displayName).toBe('أحمد');
      expect(session.accessToken).toBeTruthy();
      expect(db.rows('users')).toHaveLength(1);
      expect(db.rows('riders')).toHaveLength(1);
    });

    it('reuses the same account on second sign-in', async () => {
      const first = await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' });
      const second = await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' });

      expect(second.user.id).toBe(first.user.id);
      expect(db.rows('users')).toHaveLength(1);
    });

    // The duplicate-account failure CLAUDE.md §8 exists to prevent.
    it('treats every spelling of one number as the same account', async () => {
      firebase.register('spelling-a', { uid: 'fb-1', phoneNumber: '07701234567' });
      firebase.register('spelling-b', { uid: 'fb-1', phoneNumber: '+964 770 123 4567' });

      const a = await auth.verifyOtp({ firebaseIdToken: 'spelling-a', role: 'RIDER' });
      const b = await auth.verifyOtp({ firebaseIdToken: 'spelling-b', role: 'RIDER' });

      expect(b.user.id).toBe(a.user.id);
      expect(db.rows('users')).toHaveLength(1);
    });

    it('rejects a non-Iraqi number', async () => {
      firebase.register('foreign', { uid: 'fb-x', phoneNumber: '+15551234567' });

      await expect(
        auth.verifyOtp({ firebaseIdToken: 'foreign', role: 'RIDER' }),
      ).rejects.toThrow(/Only Iraqi mobile numbers/);
    });

    it('rejects an unverifiable Firebase token', async () => {
      await expect(
        auth.verifyOtp({ firebaseIdToken: 'forged', role: 'RIDER' }),
      ).rejects.toThrow(UnauthorizedProblem);
    });

    it('refuses a deactivated account', async () => {
      await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' });
      db.rows('users')[0]!['is_active'] = false;

      await expect(
        auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' }),
      ).rejects.toThrow(/deactivated/);
    });
  });

  // CLAUDE.md §2 - admins create drivers manually in v1, no KYC upload. A
  // driver auto-created here would be an unvetted person behind the wheel.
  describe('driver sign-in', () => {
    it('refuses to create a driver account', async () => {
      await expect(
        auth.verifyOtp({ firebaseIdToken: 'driver-token', role: 'DRIVER' }),
      ).rejects.toThrow(ForbiddenProblem);
      await expect(
        auth.verifyOtp({ firebaseIdToken: 'driver-token', role: 'DRIVER' }),
      ).rejects.toThrow(/administrator must create it first/);

      expect(db.rows('users')).toHaveLength(0);
    });

    it('signs in a driver the admin already created', async () => {
      db.rows('users').push({
        id: 'driver-1',
        role: 'DRIVER',
        phone_e164: DRIVER_PHONE,
        display_name: 'سائق',
        is_active: true,
      });

      const session = await auth.verifyOtp({
        firebaseIdToken: 'driver-token',
        role: 'DRIVER',
      });

      expect(session.user.id).toBe('driver-1');
      expect(session.user.role).toBe('DRIVER');
    });

    // The same human may be both, and the two accounts are separate rows.
    it('keeps rider and driver accounts on one number separate', async () => {
      db.rows('users').push({
        id: 'driver-1',
        role: 'DRIVER',
        phone_e164: RIDER_PHONE,
        display_name: 'سائق',
        is_active: true,
      });

      const asRider = await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' });
      const asDriver = await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'DRIVER' });

      expect(asRider.user.id).not.toBe(asDriver.user.id);
      expect(asRider.user.role).toBe('RIDER');
      expect(asDriver.user.role).toBe('DRIVER');
    });
  });

  describe('refresh and logout', () => {
    it('exchanges a refresh token for a new pair', async () => {
      const session = await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' });

      const refreshed = await auth.refresh(session.refreshToken);

      expect(refreshed.user.id).toBe(session.user.id);
      expect(refreshed.refreshToken).not.toBe(session.refreshToken);
    });

    it('rejects the old refresh token after rotation', async () => {
      const session = await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' });
      await auth.refresh(session.refreshToken);

      await expect(auth.refresh(session.refreshToken)).rejects.toThrow(UnauthorizedProblem);
    });

    it('logout invalidates every refresh token', async () => {
      const session = await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' });

      await auth.logout(session.user.id);

      await expect(auth.refresh(session.refreshToken)).rejects.toThrow(UnauthorizedProblem);
    });

    it('refuses to refresh into a deactivated account', async () => {
      const session = await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' });
      db.rows('users')[0]!['is_active'] = false;

      await expect(auth.refresh(session.refreshToken)).rejects.toThrow(/no longer active/);
    });
  });

  describe('loadUser', () => {
    it('returns the caller own profile including their own phone', async () => {
      const session = await auth.verifyOtp({ firebaseIdToken: 'rider-token', role: 'RIDER' });

      const user = await auth.loadUser(session.user.id);
      expect(user.phone).toBe(RIDER_PHONE);
    });

    it('rejects an unknown user', async () => {
      await expect(auth.loadUser('nobody')).rejects.toThrow(UnauthorizedProblem);
    });
  });
});
