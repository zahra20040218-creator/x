import {
  InvalidRideTransitionError,
  RideActorNotPermittedError,
} from '../common/problem.js';
import type { Actor, ActorType, RideSnapshot, RideStatus } from './ride.types.js';

/**
 * CLAUDE.md §4 / §12.4.
 *
 * The ONLY place a ride's status may change. Controllers, repositories and
 * workers ask this class; nothing writes `rides.status` directly.
 *
 * The authorisation rule is the part worth being careful about. It would be
 * natural to check "is the caller a driver?" in a guard and "is this transition
 * legal?" here, in two different files. That split is how driver A ends up able
 * to complete driver B's ride: both checks pass individually, and nobody owns
 * the conjunction. So the actor is part of the transition, and a rule that does
 * not name an actor cannot be performed by that actor at all.
 */

/** Who may perform a transition, beyond simply having the right role. */
type ActorRule =
  /** Any user with this role. */
  | { role: ActorType }
  /** The rider who owns the ride. */
  | { role: 'RIDER'; mustOwnRide: true }
  /** The driver currently assigned to the ride. */
  | { role: 'DRIVER'; mustBeAssignedDriver: true };

interface TransitionRule {
  from: RideStatus;
  to: RideStatus;
  actors: ActorRule[];
  /** Human-readable reason, surfaced in ride_events metadata. */
  description: string;
}

/**
 * The transition table from docs/state-machine.md, in executable form.
 *
 * Any (from, to) pair absent from this array is invalid. There is no default
 * case, no wildcard and no "admin can do anything" escape hatch - an admin
 * power is listed explicitly or it does not exist.
 */
export const TRANSITIONS: readonly TransitionRule[] = [
  {
    from: 'REQUESTED',
    to: 'OFFERED',
    actors: [{ role: 'SYSTEM' }],
    description: 'A candidate driver was selected and offered the ride.',
  },
  {
    from: 'REQUESTED',
    to: 'NO_DRIVERS_FOUND',
    actors: [{ role: 'SYSTEM' }],
    description: 'Search radius exhausted with no available driver.',
  },
  {
    from: 'REQUESTED',
    to: 'CANCELLED_BY_RIDER',
    actors: [{ role: 'RIDER', mustOwnRide: true }, { role: 'ADMIN' }],
    description: 'Rider cancelled before a driver was assigned.',
  },
  {
    from: 'OFFERED',
    to: 'ACCEPTED',
    // Only the assigned driver. The caller must ALSO hold the Redis claim -
    // that is enforced by RideClaimService before this is reached, and is the
    // guarantee that only one driver ever gets here (CLAUDE.md §5.1).
    actors: [{ role: 'DRIVER', mustBeAssignedDriver: true }],
    description: 'Driver accepted the offer and won the atomic claim.',
  },
  {
    from: 'OFFERED',
    to: 'EXPIRED',
    actors: [{ role: 'SYSTEM' }],
    description: 'Offer timed out or was declined.',
  },
  {
    from: 'OFFERED',
    to: 'CANCELLED_BY_RIDER',
    actors: [{ role: 'RIDER', mustOwnRide: true }, { role: 'ADMIN' }],
    description: 'Rider cancelled while an offer was outstanding.',
  },
  {
    from: 'EXPIRED',
    to: 'REQUESTED',
    actors: [{ role: 'SYSTEM' }],
    description: 'Returned to the matching pool for the next candidate.',
  },
  {
    from: 'EXPIRED',
    to: 'NO_DRIVERS_FOUND',
    actors: [{ role: 'SYSTEM' }],
    description: 'No further candidates remained after the offer expired.',
  },
  {
    from: 'ACCEPTED',
    to: 'DRIVER_ARRIVED',
    actors: [{ role: 'DRIVER', mustBeAssignedDriver: true }, { role: 'ADMIN' }],
    description: 'Driver reached the pickup point.',
  },
  {
    from: 'ACCEPTED',
    to: 'CANCELLED_BY_DRIVER',
    actors: [{ role: 'DRIVER', mustBeAssignedDriver: true }, { role: 'ADMIN' }],
    description: 'Driver cancelled before pickup.',
  },
  {
    from: 'ACCEPTED',
    to: 'CANCELLED_BY_RIDER',
    actors: [{ role: 'RIDER', mustOwnRide: true }, { role: 'ADMIN' }],
    description: 'Rider cancelled after a driver was assigned.',
  },
  {
    from: 'DRIVER_ARRIVED',
    to: 'IN_PROGRESS',
    actors: [{ role: 'DRIVER', mustBeAssignedDriver: true }, { role: 'ADMIN' }],
    description: 'Rider boarded; trip started.',
  },
  {
    from: 'DRIVER_ARRIVED',
    to: 'CANCELLED_BY_DRIVER',
    actors: [{ role: 'DRIVER', mustBeAssignedDriver: true }, { role: 'ADMIN' }],
    description: 'Driver cancelled at the pickup point.',
  },
  {
    from: 'DRIVER_ARRIVED',
    to: 'CANCELLED_BY_RIDER',
    actors: [{ role: 'RIDER', mustOwnRide: true }, { role: 'ADMIN' }],
    description: 'Rider cancelled at the pickup point.',
  },
  {
    from: 'IN_PROGRESS',
    to: 'COMPLETED',
    actors: [{ role: 'DRIVER', mustBeAssignedDriver: true }, { role: 'ADMIN' }],
    description: 'Trip finished; fare settled and ledger written.',
  },
  {
    from: 'IN_PROGRESS',
    // CLAUDE.md §4 marks this admin-only, and it stays that way: a driver who
    // could cancel mid-trip could strand a rider and void the fare.
    to: 'CANCELLED_IN_TRIP',
    actors: [{ role: 'ADMIN' }],
    description: 'Admin aborted a running trip.',
  },
];

export interface TransitionRequest {
  ride: RideSnapshot;
  to: RideStatus;
  actor: Actor;
  metadata?: Record<string, unknown>;
}

export interface TransitionDecision {
  rideId: string;
  from: RideStatus;
  to: RideStatus;
  actorType: ActorType;
  actorId: string | null;
  description: string;
  metadata: Record<string, unknown>;
}

export class RideStateMachine {
  private readonly byFrom: ReadonlyMap<RideStatus, readonly TransitionRule[]>;

  constructor(rules: readonly TransitionRule[] = TRANSITIONS) {
    const map = new Map<RideStatus, TransitionRule[]>();
    for (const rule of rules) {
      const list = map.get(rule.from);
      if (list) list.push(rule);
      else map.set(rule.from, [rule]);
    }
    this.byFrom = map;
  }

  /** Every state reachable from `from`, ignoring who is asking. */
  allowedTargets(from: RideStatus): RideStatus[] {
    return (this.byFrom.get(from) ?? []).map((r) => r.to);
  }

  /** True if the pair is in the table at all. Says nothing about the actor. */
  isTransitionDefined(from: RideStatus, to: RideStatus): boolean {
    return (this.byFrom.get(from) ?? []).some((r) => r.to === to);
  }

  /**
   * Validate a transition and return what should be written.
   *
   * Returns a decision rather than performing the write: persistence is the
   * repository's job, and keeping this class free of I/O is what lets the
   * whole table be tested exhaustively without a database.
   *
   * @throws InvalidRideTransitionError  409 - the pair is not in the table.
   * @throws RideActorNotPermittedError  403 - the pair is legal, this actor is not.
   */
  validate(request: TransitionRequest): TransitionDecision {
    const { ride, to, actor } = request;
    const from = ride.status;

    const rule = (this.byFrom.get(from) ?? []).find((r) => r.to === to);

    // CLAUDE.md §4: never a silent no-op. A same-state "transition" is still
    // invalid unless the table lists it, and the table lists none - so
    // COMPLETED -> COMPLETED raises rather than quietly succeeding.
    if (!rule) throw new InvalidRideTransitionError(from, to);

    if (!this.actorSatisfies(rule, ride, actor)) {
      throw new RideActorNotPermittedError(
        `A ${actor.type} may not move this ride from ${from} to ${to}.`,
      );
    }

    return {
      rideId: ride.id,
      from,
      to,
      actorType: actor.type,
      actorId: actor.id ?? null,
      description: rule.description,
      metadata: request.metadata ?? {},
    };
  }

  /** Non-throwing form, for building UI affordances. */
  can(request: TransitionRequest): boolean {
    try {
      this.validate(request);
      return true;
    } catch {
      return false;
    }
  }

  private actorSatisfies(rule: TransitionRule, ride: RideSnapshot, actor: Actor): boolean {
    return rule.actors.some((allowed) => {
      if (allowed.role !== actor.type) return false;

      // SYSTEM transitions are performed by workers and carry no user id.
      if (allowed.role === 'SYSTEM') return true;

      // Every non-SYSTEM actor must be identified. An unauthenticated or
      // anonymous caller cannot satisfy an ownership rule.
      if (!actor.id) return false;

      if ('mustOwnRide' in allowed && allowed.mustOwnRide) {
        return ride.riderId === actor.id;
      }

      if ('mustBeAssignedDriver' in allowed && allowed.mustBeAssignedDriver) {
        // Not merely "is a driver" - is THE driver on this ride. A null
        // driverId can never match, so an unassigned ride cannot be advanced
        // by a driver who was never offered it.
        return ride.driverId !== null && ride.driverId === actor.id;
      }

      // A bare { role } rule: the role alone is sufficient. Only ADMIN uses
      // this, and only for the transitions listed above.
      return true;
    });
  }
}
