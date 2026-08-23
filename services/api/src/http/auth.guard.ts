import {
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuthService } from '../auth/auth.service.js';
import { TokenService, type UserRole } from '../auth/token.service.js';
import { ForbiddenProblem, UnauthorizedProblem } from '../common/problem.js';
import type { Actor } from '../rides/ride.types.js';

/**
 * Authentication and role authorisation.
 *
 * Note what this guard deliberately does NOT do: it does not check whether the
 * caller owns the resource. Ownership lives inside `RideStateMachine` and
 * `RideService`, because a guard and a service checking different halves of
 * "may this person do this" is exactly how driver A ends up able to complete
 * driver B's ride - both checks pass individually and nobody owns the
 * conjunction (see ride-state-machine.ts).
 *
 * So: this guard answers "who are you", the domain answers "may you".
 */

export const IS_PUBLIC = 'isPublic';

/**
 * `CustomDecorator`, not `MethodDecorator`: `@Roles` is applied to a CLASS on
 * AdminController so that a method added there is admin-only by default.
 * Typing it as a method decorator would make that safer default a type error.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_ROLES = 'requiredRoles';
export const Roles = (...roles: UserRole[]): CustomDecorator<string> =>
  SetMetadata(REQUIRED_ROLES, roles);

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedProblem('A bearer token is required.');
    }

    const claims = await this.tokens.verifyAccessToken(header.slice('Bearer '.length));

    // Loaded from the database rather than trusted from the token: a
    // deactivated or suspended account must stop working immediately, not when
    // its access token happens to expire an hour later. The session id is
    // checked in the same call, so a revoked session dies just as fast.
    const user = await this.auth.loadUser(claims.sub, claims.sid);
    request.user = user;

    const required = this.reflector.getAllAndOverride<UserRole[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required && required.length > 0 && !required.includes(user.role)) {
      throw new ForbiddenProblem('This endpoint is not available for your account type.');
    }

    return true;
  }
}

/** `@CurrentUser() user: AuthenticatedUser` */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) throw new UnauthorizedProblem();
    return request.user;
  },
);

/** `@CurrentActor() actor: Actor` — the shape the domain layer expects. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) throw new UnauthorizedProblem();
    return { type: request.user.role, id: request.user.id };
  },
);
