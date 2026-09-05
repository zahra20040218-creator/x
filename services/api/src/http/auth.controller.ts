import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';

import { AccountDeletionService } from '../auth/account-deletion.service.js';
import { AuthService, type AuthenticatedUser } from '../auth/auth.service.js';
import { DATABASE, type Database } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PushService } from '../push/push.service.js';
import { CapabilityService } from '../capabilities/capability.service.js';
import { CurrentUser, Public } from './auth.guard.js';
import { RateLimit } from './rate-limit.js';
import {
  RefreshSchema,
  RegisterDeviceSchema,
  UnregisterDeviceSchema,
  UpdateMeSchema,
  VerifyOtpSchema,
} from './schemas.js';
import { zodBody } from './zod.pipe.js';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly ledger: LedgerService,
    @Inject(DATABASE) private readonly db: Database,
    private readonly push: PushService,
    // Named with a trailing underscore only because `capabilities` is also the
    // handler name below; the property is the service.
    private readonly capabilities_: CapabilityService,
    private readonly accountDeletion: AccountDeletionService,
  ) {}

  @Post('auth/otp/verify')
  @Public()
  // The tightest limit in the system, and the reason rate limiting exists.
  // Unauthenticated by necessity, and every call costs a real Firebase
  // verification - unbounded it is both a bill and an enumeration oracle.
  // 10/minute per IP is far above any honest sign-in and far below abuse.
  @RateLimit({ limit: 10, windowSeconds: 60, by: 'ip', tier: 'CRITICAL' })
  @HttpCode(200)
  async verifyOtp(
    @Body(zodBody(VerifyOtpSchema))
    body: { firebaseIdToken: string; role: 'RIDER' | 'DRIVER'; displayName?: string },
  ) {
    const session = await this.auth.verifyOtp({
      firebaseIdToken: body.firebaseIdToken,
      role: body.role,
      displayName: body.displayName,
    });

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  @Post('auth/refresh')
  @Public()
  // Refresh rotates, so an honest client refreshes about once an hour. A flood
  // here is either a broken client retry loop or someone brute-forcing tokens.
  @RateLimit({ limit: 30, windowSeconds: 60, by: 'ip', tier: 'CRITICAL' })
  @HttpCode(200)
  async refresh(@Body(zodBody(RefreshSchema)) body: { refreshToken: string }) {
    const session = await this.auth.refresh(body.refreshToken);
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.auth.logout(user.id);
  }

  /**
   * Register this device for push. See docs/api-contract.yaml (added 2026-08-23).
   *
   * Rate-limited as CRITICAL: it writes a row keyed on an attacker-supplied
   * string, and it is the only endpoint that can move a device token from one
   * account to another.
   */
  @Post('devices')
  @HttpCode(204)
  @RateLimit({ limit: 30, windowSeconds: 60, by: 'user', tier: 'CRITICAL' })
  async registerDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(RegisterDeviceSchema)) body: { token: string; platform: 'ANDROID' | 'IOS' },
  ): Promise<void> {
    await this.push.register(user.id, body.token, body.platform);
  }

  /**
   * Stop delivering to this device.
   *
   * Separate from logout on purpose: logout ends the SESSION, and a driver may
   * legitimately want offers to stop reaching one particular handset without
   * signing out everywhere.
   */
  @Delete('devices')
  @HttpCode(204)
  @RateLimit({ limit: 30, windowSeconds: 60, by: 'user', tier: 'STANDARD' })
  async unregisterDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(UnregisterDeviceSchema)) body: { token: string },
  ): Promise<void> {
    await this.push.unregister(user.id, body.token);
  }

  /**
   * What this account may do, decided by the server.
   *
   * CLAUDE.md §1.1: ALY is one app with a Rider mode and a Driver mode, and the
   * app must not decide which it may enter. This is the authoritative answer,
   * and it is the SAME object the server enforces with - `requireDriver` calls
   * the same `evaluate`. If this endpoint and the guard could disagree, the app
   * would be offering a mode the server is about to refuse.
   *
   * Deliberately returns the full blocker list rather than the first failure. A
   * driver who is unapproved AND missing a licence needs to see both, or they
   * fix one, try again, and learn the second only by failing again.
   *
   * No rate limit tier beyond the default: the app calls this on launch, on
   * resume, and after any change to its own state, and throttling it would make
   * the UI show a stale entitlement.
   */
  @Get('me/capabilities')
  async capabilities(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.capabilities_.evaluate(user.id);
    return {
      userId: result.userId,
      canRide: result.canRide,
      driver: {
        allowed: result.driver.allowed,
        blockers: result.driver.blockers,
        suspendedReason: result.driver.suspendedReason,
        missingDocuments: result.driver.missingDocuments,
        expiredDocuments: result.driver.expiredDocuments,
        rejectedDocuments: result.driver.rejectedDocuments,
        subscriptionExpiresAt: result.driver.subscriptionExpiresAt?.toISOString() ?? null,
      },
    };
  }

  /** The caller's OWN profile — the only shape that carries their phone. */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    const base = {
      id: user.id,
      role: user.role,
      displayName: user.displayName,
      phone: user.phone,
    };

    if (user.role !== 'DRIVER') return base;

    const result = await this.db.query<{
      availability: string; is_suspended: boolean;
      vehicle_plate: string; vehicle_model: string; vehicle_color: string;
      rating_sum: string; rating_count: string;
    }>(
      `SELECT availability, is_suspended, vehicle_plate, vehicle_model, vehicle_color,
              rating_sum, rating_count
         FROM drivers WHERE user_id = $1`,
      [user.id],
    );
    const row = result.rows[0];
    if (!row) return base;

    const count = Number(row.rating_count);

    return {
      ...base,
      rating: count > 0 ? Math.round((Number(row.rating_sum) / count) * 10) / 10 : null,
      driver: {
        availability: row.availability,
        isSuspended: row.is_suspended,
        vehicle: {
          plate: row.vehicle_plate,
          model: row.vehicle_model,
          color: row.vehicle_color,
        },
      },
      walletBalanceIqd: await this.ledger.balanceFor(this.db, user.id),
    };
  }

  /**
   * Erase this account, at the user's own request.
   *
   * Google Play requires an in-app path to account deletion, and there was
   * none - which blocks publication on its own, independently of how finished
   * anything else is.
   *
   * Rate limited hard and keyed to the user. This is destructive and
   * irreversible, and nobody deletes their account thirty times a minute; a
   * burst is a stuck client or a hijacked session, and either deserves a 429.
   */
  @Post('me/delete')
  @RateLimit({ limit: 3, windowSeconds: 3_600, by: 'user', tier: 'CRITICAL' })
  @HttpCode(204)
  async deleteMe(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.accountDeletion.deleteOwnAccount(user.id);
  }

  @Patch('me')
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(UpdateMeSchema)) body: { displayName: string },
  ) {
    await this.db.query(
      `UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2`,
      [body.displayName, user.id],
    );
    return { ...user, displayName: body.displayName };
  }
}
