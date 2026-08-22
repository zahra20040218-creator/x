import { Body, Controller, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';

import { AuthService, type AuthenticatedUser } from '../auth/auth.service.js';
import { DATABASE, type Database } from '../db/db.port.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { CurrentUser, Public } from './auth.guard.js';
import { RefreshSchema, UpdateMeSchema, VerifyOtpSchema } from './schemas.js';
import { zodBody } from './zod.pipe.js';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly ledger: LedgerService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Post('auth/otp/verify')
  @Public()
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
