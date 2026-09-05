/**
 * RFC 9457 problem+json. CLAUDE.md §9: "Validation errors return RFC 9457
 * problem+json."
 *
 * Every error the API returns is one of these. The reason to centralise it is
 * not tidiness - it is that ad-hoc error shapes leak. A handler that returns
 * `{ error: err.message }` will one day return a Postgres message containing a
 * phone number, or a stack trace naming an internal path. Here, the message a
 * client sees is always one this file chose.
 */

export const PROBLEM_BASE = 'https://api.rideapp.iq/problems';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: Array<{ path: string; message: string }>;
  [key: string]: unknown;
}

/**
 * Base class for every error that is safe to show a client.
 *
 * Anything NOT deriving from this is treated as an internal fault and becomes a
 * generic 500 with no detail - which is the correct default, because an
 * unplanned error's message was never reviewed for what it discloses.
 */
export class ProblemError extends Error {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly extra: Record<string, unknown>;

  constructor(args: {
    type: string;
    title: string;
    status: number;
    detail?: string;
    extra?: Record<string, unknown>;
  }) {
    super(args.detail ?? args.title);
    this.name = new.target.name;
    this.type = `${PROBLEM_BASE}/${args.type}`;
    this.title = args.title;
    this.status = args.status;
    this.detail = args.detail;
    this.extra = args.extra ?? {};
  }

  toBody(requestId?: string, instance?: string): ProblemBody {
    const body: ProblemBody = {
      type: this.type,
      title: this.title,
      status: this.status,
      ...this.extra,
    };
    if (this.detail !== undefined) body.detail = this.detail;
    if (instance !== undefined) body.instance = instance;
    if (requestId !== undefined) body.requestId = requestId;
    return body;
  }
}

// ---------------------------------------------------------------------------
// Concrete problems. One class per thing that can go wrong, so that a handler
// cannot invent a new error shape at the call site.
// ---------------------------------------------------------------------------

export class ValidationProblem extends ProblemError {
  constructor(errors: Array<{ path: string; message: string }>) {
    super({
      type: 'validation-failed',
      title: 'Request validation failed',
      status: 422,
      detail: 'One or more fields are invalid.',
      extra: { errors },
    });
  }
}

export class UnauthorizedProblem extends ProblemError {
  constructor(detail = 'Authentication is required.') {
    super({ type: 'unauthorized', title: 'Unauthorized', status: 401, detail });
  }
}

export class ForbiddenProblem extends ProblemError {
  constructor(detail = 'You are not permitted to perform this action.') {
    super({ type: 'forbidden', title: 'Forbidden', status: 403, detail });
  }
}

/**
 * Used for "does not exist" AND for "exists but is not yours".
 *
 * Deliberately the same response in both cases. If a rider probing
 * /rides/{uuid} got 403 for someone else's ride and 404 for a nonexistent one,
 * the endpoint would confirm which ride ids are real - a slow but real
 * enumeration oracle (ACCEPTANCE_CHECKLIST.md check 5).
 */
export class NotFoundProblem extends ProblemError {
  constructor(resource = 'Resource') {
    super({
      type: 'not-found',
      title: 'Not found',
      status: 404,
      detail: `${resource} was not found.`,
    });
  }
}

/**
 * A webhook whose body could not be understood.
 *
 * 400 rather than 422: the payload is not a validation failure in OUR schema,
 * it is a message from another company's system that this handler does not
 * model, and the contract documents 400 for it.
 *
 * The detail carries NO reason. `processWebhook` distinguishes
 * MALFORMED_PAYLOAD from UNSUPPORTED_EVENT from INVALID_AMOUNT, and every one
 * of those distinctions is useful to an attacker probing an unauthenticated
 * endpoint and useless to a legitimate provider, which has our documentation.
 */
export class BadWebhookPayloadProblem extends ProblemError {
  constructor() {
    super({
      type: 'bad-webhook-payload',
      title: 'Bad webhook payload',
      status: 400,
      detail: 'The webhook payload could not be processed.',
    });
  }
}

export class ConflictProblem extends ProblemError {
  constructor(detail: string, extra?: Record<string, unknown>) {
    super({
      type: 'conflict',
      title: 'Conflict',
      status: 409,
      detail,
      ...(extra ? { extra } : {}),
    });
  }
}

/**
 * A driver cannot go online because a required document is missing or lapsed.
 *
 * 403, not 409: nothing about the request conflicts with current state, the
 * driver is simply not permitted to work yet.
 *
 * The lists are machine-readable document type names, never prose. The driver
 * app renders them in Arabic through its own localisation layer (CLAUDE.md §8)
 * — a server that returns a translated sentence has decided the user's language
 * for them, and gets it wrong the moment anyone opens the app in English.
 */
export class DriverNotCompliantProblem extends ProblemError {
  constructor(missing: readonly string[], expired: readonly string[], rejected: readonly string[]) {
    super({
      type: 'driver-not-compliant',
      title: 'Driver documents incomplete',
      status: 403,
      detail: 'One or more required driver documents are missing, rejected or expired.',
      extra: { missing, expired, rejected },
    });
  }
}

/**
 * A driver-scoped action attempted by an account that may not currently drive.
 *
 * CLAUDE.md §1.1. Distinct from `DriverNotCompliantProblem`, which is the
 * narrow documents case and keeps its own shape because the driver app already
 * renders it: this covers approval, suspension, subscription and "not a driver
 * at all", which is what a rider gets when their client enters Driver mode
 * without asking the server.
 *
 * `blockers` is the full list, machine-readable, never prose - the app
 * localises it (CLAUDE.md §8). `suspendedReason` is the one exception and is
 * text an administrator typed, passed through so the driver can read what they
 * were actually told rather than a generic refusal.
 *
 * 403 and not 404: unlike an offer they were never given, a driver IS entitled
 * to know their own account is blocked and why.
 */
export class DriverModeUnavailableProblem extends ProblemError {
  constructor(blockers: readonly string[], suspendedReason: string | null = null) {
    super({
      type: 'driver-mode-unavailable',
      title: 'Driver mode unavailable',
      status: 403,
      detail: 'This account may not use driver mode.',
      extra: { blockers, suspendedReason },
    });
  }
}

/** CLAUDE.md §4 - an invalid transition is 409 and never a silent no-op. */
export class InvalidRideTransitionError extends ProblemError {
  constructor(
    readonly fromState: string,
    readonly toState: string,
  ) {
    super({
      type: 'invalid-ride-transition',
      title: 'Invalid ride transition',
      status: 409,
      detail: `Cannot move ride from ${fromState} to ${toState}.`,
      extra: { fromState, toState },
    });
  }
}

/** CLAUDE.md §4 - the actor is not allowed to drive this ride's transitions. */
export class RideActorNotPermittedError extends ProblemError {
  constructor(detail = 'This actor may not change this ride.') {
    super({
      type: 'ride-actor-not-permitted',
      title: 'Actor not permitted',
      status: 403,
      detail,
    });
  }
}

/** CLAUDE.md §5.1 - lost the atomic claim race. Exactly one driver avoids this. */
export class RideAlreadyClaimedError extends ProblemError {
  constructor(detail = 'This ride has already been taken by another driver.') {
    super({
      type: 'ride-already-claimed',
      title: 'Ride already claimed',
      status: 409,
      detail,
    });
  }
}

/** CLAUDE.md §5.2 - same key, different body. Replaying a key must be safe. */
export class IdempotencyKeyReusedError extends ProblemError {
  constructor() {
    super({
      type: 'idempotency-key-reused',
      title: 'Idempotency key reused with a different request',
      status: 409,
      detail:
        'This Idempotency-Key was already used for a different request body. ' +
        'Generate a new key for a new request.',
    });
  }
}

/** CLAUDE.md §7 - the gateway provider is a stub in v1. */
export class NotImplementedError extends ProblemError {
  constructor(what: string) {
    super({
      type: 'not-implemented',
      title: 'Not implemented',
      status: 501,
      detail: `${what} is not implemented in v1.`,
    });
  }
}

export class ServiceUnavailableProblem extends ProblemError {
  constructor(detail = 'A dependency is unavailable.') {
    super({
      type: 'service-unavailable',
      title: 'Service unavailable',
      status: 503,
      detail,
    });
  }
}

/**
 * The fallback for anything that is not a ProblemError.
 *
 * Note it takes no detail from the original error on purpose. An unexpected
 * exception's message is unreviewed text - it can carry a phone number from a
 * constraint violation, a file path, or a fragment of a query.
 */
export function internalProblem(requestId?: string, instance?: string): ProblemBody {
  const body: ProblemBody = {
    type: `${PROBLEM_BASE}/internal-error`,
    title: 'Internal server error',
    status: 500,
    detail: 'An unexpected error occurred. The request id identifies it in the logs.',
  };
  if (instance !== undefined) body.instance = instance;
  if (requestId !== undefined) body.requestId = requestId;
  return body;
}
