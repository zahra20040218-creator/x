import { describe, expect, it } from 'vitest';

import {
  InvalidRideTransitionError,
  RideActorNotPermittedError,
} from '../common/problem.js';
import { RideStateMachine, TRANSITIONS } from './ride-state-machine.js';
import {
  ACTOR_TYPES,
  isTerminal,
  RIDE_STATUSES,
  TERMINAL_STATUSES,
  type Actor,
  type RideSnapshot,
  type RideStatus,
} from './ride.types.js';

const RIDER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const RIDER_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const DRIVER_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const DRIVER_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ADMIN = 'cccccccc-0000-4000-8000-000000000001';

const machine = new RideStateMachine();

function ride(status: RideStatus, overrides: Partial<RideSnapshot> = {}): RideSnapshot {
  return {
    id: 'dddddddd-0000-4000-8000-000000000001',
    status,
    riderId: RIDER_A,
    driverId: DRIVER_A,
    ...overrides,
  };
}

const SYSTEM: Actor = { type: 'SYSTEM' };
const RIDER_ACTOR: Actor = { type: 'RIDER', id: RIDER_A };
const DRIVER_ACTOR: Actor = { type: 'DRIVER', id: DRIVER_A };
const ADMIN_ACTOR: Actor = { type: 'ADMIN', id: ADMIN };

/** An actor known to be permitted for a given rule, used to isolate other checks. */
function anyPermittedActor(from: RideStatus, to: RideStatus): Actor {
  const rule = TRANSITIONS.find((r) => r.from === from && r.to === to)!;
  const allowed = rule.actors[0]!;
  switch (allowed.role) {
    case 'SYSTEM':
      return SYSTEM;
    case 'RIDER':
      return RIDER_ACTOR;
    case 'DRIVER':
      return DRIVER_ACTOR;
    case 'ADMIN':
      return ADMIN_ACTOR;
  }
}

describe('RideStateMachine - the transition table', () => {
  it('matches docs/state-machine.md exactly', () => {
    const pairs = TRANSITIONS.map((t) => `${t.from}->${t.to}`).sort();
    expect(pairs).toEqual(
      [
        'REQUESTED->OFFERED',
        'REQUESTED->NO_DRIVERS_FOUND',
        'REQUESTED->CANCELLED_BY_RIDER',
        'OFFERED->ACCEPTED',
        'OFFERED->EXPIRED',
        'OFFERED->CANCELLED_BY_RIDER',
        'EXPIRED->REQUESTED',
        'EXPIRED->NO_DRIVERS_FOUND',
        'ACCEPTED->DRIVER_ARRIVED',
        'ACCEPTED->CANCELLED_BY_DRIVER',
        'ACCEPTED->CANCELLED_BY_RIDER',
        'DRIVER_ARRIVED->IN_PROGRESS',
        'DRIVER_ARRIVED->CANCELLED_BY_DRIVER',
        'DRIVER_ARRIVED->CANCELLED_BY_RIDER',
        'IN_PROGRESS->COMPLETED',
        'IN_PROGRESS->CANCELLED_IN_TRIP',
      ].sort(),
    );
  });

  it('has no duplicate (from, to) pairs', () => {
    const pairs = TRANSITIONS.map((t) => `${t.from}->${t.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('never allows a transition out of a terminal state', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(machine.allowedTargets(status)).toEqual([]);
    }
  });

  it('lists every non-terminal state as having somewhere to go', () => {
    for (const status of RIDE_STATUSES) {
      if (!isTerminal(status)) {
        expect(machine.allowedTargets(status).length).toBeGreaterThan(0);
      }
    }
  });

  // The important half of the table is the part that is NOT in it. This walks
  // all 11 x 11 pairs and asserts that everything unlisted raises 409.
  it('rejects every pair that is not explicitly listed', () => {
    const listed = new Set(TRANSITIONS.map((t) => `${t.from}->${t.to}`));
    let rejected = 0;

    for (const from of RIDE_STATUSES) {
      for (const to of RIDE_STATUSES) {
        if (listed.has(`${from}->${to}`)) continue;

        for (const actorType of ACTOR_TYPES) {
          const actor: Actor = { type: actorType, id: actorType === 'SYSTEM' ? undefined : ADMIN };
          expect(() => machine.validate({ ride: ride(from), to, actor })).toThrow(
            InvalidRideTransitionError,
          );
        }
        rejected++;
      }
    }

    expect(rejected).toBe(RIDE_STATUSES.length * RIDE_STATUSES.length - listed.size);
  });

  // CLAUDE.md §4: "It never silently no-ops."
  it('raises on a same-state transition instead of quietly succeeding', () => {
    for (const status of RIDE_STATUSES) {
      expect(() =>
        machine.validate({ ride: ride(status), to: status, actor: ADMIN_ACTOR }),
      ).toThrow(InvalidRideTransitionError);
    }
  });

  it('reports 409 and both states on an invalid transition', () => {
    try {
      machine.validate({ ride: ride('COMPLETED'), to: 'IN_PROGRESS', actor: ADMIN_ACTOR });
      expect.unreachable('should have thrown');
    } catch (error) {
      const problem = error as InvalidRideTransitionError;
      expect(problem.status).toBe(409);
      expect(problem.fromState).toBe('COMPLETED');
      expect(problem.toState).toBe('IN_PROGRESS');
      expect(problem.toBody().type).toMatch(/invalid-ride-transition$/);
    }
  });
});

describe('RideStateMachine - the happy path', () => {
  it('walks REQUESTED to COMPLETED', () => {
    const steps: Array<[RideStatus, RideStatus, Actor]> = [
      ['REQUESTED', 'OFFERED', SYSTEM],
      ['OFFERED', 'ACCEPTED', DRIVER_ACTOR],
      ['ACCEPTED', 'DRIVER_ARRIVED', DRIVER_ACTOR],
      ['DRIVER_ARRIVED', 'IN_PROGRESS', DRIVER_ACTOR],
      ['IN_PROGRESS', 'COMPLETED', DRIVER_ACTOR],
    ];

    for (const [from, to, actor] of steps) {
      const decision = machine.validate({ ride: ride(from), to, actor });
      expect(decision.from).toBe(from);
      expect(decision.to).toBe(to);
      expect(decision.actorType).toBe(actor.type);
      expect(decision.description).toBeTruthy();
    }
  });

  it('walks the offer-timeout retry loop', () => {
    expect(machine.can({ ride: ride('OFFERED'), to: 'EXPIRED', actor: SYSTEM })).toBe(true);
    expect(machine.can({ ride: ride('EXPIRED'), to: 'REQUESTED', actor: SYSTEM })).toBe(true);
    expect(machine.can({ ride: ride('EXPIRED'), to: 'NO_DRIVERS_FOUND', actor: SYSTEM })).toBe(true);
  });

  it('carries metadata and the actor id into the decision', () => {
    const decision = machine.validate({
      ride: ride('IN_PROGRESS'),
      to: 'COMPLETED',
      actor: DRIVER_ACTOR,
      metadata: { actualDistanceM: 4_200 },
    });

    expect(decision.actorId).toBe(DRIVER_A);
    expect(decision.metadata).toEqual({ actualDistanceM: 4_200 });
    expect(decision.rideId).toBe('dddddddd-0000-4000-8000-000000000001');
  });

  it('defaults metadata to an empty object', () => {
    expect(machine.validate({ ride: ride('REQUESTED'), to: 'OFFERED', actor: SYSTEM }).metadata)
      .toEqual({});
  });

  it('records a null actor id for SYSTEM', () => {
    expect(machine.validate({ ride: ride('REQUESTED'), to: 'OFFERED', actor: SYSTEM }).actorId)
      .toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Authorisation. ACCEPTANCE_CHECKLIST.md check 5 is the acceptance criterion
// this section exists to satisfy: one user must not be able to touch another's
// ride, and the check must live inside the transition rather than beside it.
// ---------------------------------------------------------------------------

describe('RideStateMachine - actor authorisation', () => {
  it('refuses a driver who is not the assigned driver', () => {
    const otherDriver: Actor = { type: 'DRIVER', id: DRIVER_B };

    for (const [from, to] of [
      ['ACCEPTED', 'DRIVER_ARRIVED'],
      ['DRIVER_ARRIVED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'COMPLETED'],
      ['ACCEPTED', 'CANCELLED_BY_DRIVER'],
    ] as Array<[RideStatus, RideStatus]>) {
      expect(() =>
        machine.validate({ ride: ride(from, { driverId: DRIVER_A }), to, actor: otherDriver }),
      ).toThrow(RideActorNotPermittedError);
    }
  });

  it('refuses a rider cancelling a ride that is not theirs', () => {
    const otherRider: Actor = { type: 'RIDER', id: RIDER_B };

    for (const from of ['REQUESTED', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVED'] as RideStatus[]) {
      expect(() =>
        machine.validate({
          ride: ride(from, { riderId: RIDER_A }),
          to: 'CANCELLED_BY_RIDER',
          actor: otherRider,
        }),
      ).toThrow(RideActorNotPermittedError);
    }
  });

  it('permits the owning rider to cancel', () => {
    for (const from of ['REQUESTED', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVED'] as RideStatus[]) {
      expect(
        machine.can({ ride: ride(from), to: 'CANCELLED_BY_RIDER', actor: RIDER_ACTOR }),
      ).toBe(true);
    }
  });

  it('refuses a driver on a ride with no driver assigned', () => {
    expect(() =>
      machine.validate({
        ride: ride('OFFERED', { driverId: null }),
        to: 'ACCEPTED',
        actor: DRIVER_ACTOR,
      }),
    ).toThrow(RideActorNotPermittedError);
  });

  it('refuses an actor with no id where ownership is required', () => {
    expect(() =>
      machine.validate({
        ride: ride('ACCEPTED'),
        to: 'DRIVER_ARRIVED',
        actor: { type: 'DRIVER' },
      }),
    ).toThrow(RideActorNotPermittedError);

    expect(() =>
      machine.validate({
        ride: ride('REQUESTED'),
        to: 'CANCELLED_BY_RIDER',
        actor: { type: 'RIDER' },
      }),
    ).toThrow(RideActorNotPermittedError);
  });

  it('refuses a rider trying to drive the driver-only transitions', () => {
    for (const [from, to] of [
      ['OFFERED', 'ACCEPTED'],
      ['ACCEPTED', 'DRIVER_ARRIVED'],
      ['DRIVER_ARRIVED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'COMPLETED'],
    ] as Array<[RideStatus, RideStatus]>) {
      expect(() => machine.validate({ ride: ride(from), to, actor: RIDER_ACTOR })).toThrow(
        RideActorNotPermittedError,
      );
    }
  });

  // CLAUDE.md §4 marks CANCELLED_IN_TRIP admin-only.
  it('lets only an admin abort a ride in progress', () => {
    expect(machine.can({ ride: ride('IN_PROGRESS'), to: 'CANCELLED_IN_TRIP', actor: ADMIN_ACTOR }))
      .toBe(true);

    for (const actor of [DRIVER_ACTOR, RIDER_ACTOR, SYSTEM]) {
      expect(() =>
        machine.validate({ ride: ride('IN_PROGRESS'), to: 'CANCELLED_IN_TRIP', actor }),
      ).toThrow(RideActorNotPermittedError);
    }
  });

  it('does not let SYSTEM perform user-driven transitions', () => {
    for (const [from, to] of [
      ['OFFERED', 'ACCEPTED'],
      ['IN_PROGRESS', 'COMPLETED'],
      ['REQUESTED', 'CANCELLED_BY_RIDER'],
    ] as Array<[RideStatus, RideStatus]>) {
      expect(() => machine.validate({ ride: ride(from), to, actor: SYSTEM })).toThrow(
        RideActorNotPermittedError,
      );
    }
  });

  it('does not let a user perform SYSTEM-driven transitions', () => {
    for (const [from, to] of [
      ['REQUESTED', 'OFFERED'],
      ['REQUESTED', 'NO_DRIVERS_FOUND'],
      ['OFFERED', 'EXPIRED'],
      ['EXPIRED', 'REQUESTED'],
      ['EXPIRED', 'NO_DRIVERS_FOUND'],
    ] as Array<[RideStatus, RideStatus]>) {
      for (const actor of [RIDER_ACTOR, DRIVER_ACTOR, ADMIN_ACTOR]) {
        expect(() => machine.validate({ ride: ride(from), to, actor })).toThrow(
          RideActorNotPermittedError,
        );
      }
    }
  });

  // Exhaustive: for every legal pair, every actor type is either explicitly
  // allowed by the rule or rejected with 403. Nothing falls through.
  it('either permits or rejects every actor type on every legal pair, with no third outcome', () => {
    for (const rule of TRANSITIONS) {
      for (const actorType of ACTOR_TYPES) {
        const actor: Actor = {
          type: actorType,
          id:
            actorType === 'SYSTEM'
              ? undefined
              : actorType === 'RIDER'
                ? RIDER_A
                : actorType === 'DRIVER'
                  ? DRIVER_A
                  : ADMIN,
        };

        const permitted = machine.can({ ride: ride(rule.from), to: rule.to, actor });
        const declared = rule.actors.some((a) => a.role === actorType);
        expect(permitted).toBe(declared);
      }
    }
  });

  it('reports 403, not 409, when the pair is legal but the actor is not', () => {
    try {
      machine.validate({
        ride: ride('IN_PROGRESS', { driverId: DRIVER_A }),
        to: 'COMPLETED',
        actor: { type: 'DRIVER', id: DRIVER_B },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RideActorNotPermittedError).status).toBe(403);
    }
  });
});

describe('RideStateMachine - query helpers', () => {
  it('isTransitionDefined ignores the actor', () => {
    expect(machine.isTransitionDefined('IN_PROGRESS', 'COMPLETED')).toBe(true);
    expect(machine.isTransitionDefined('IN_PROGRESS', 'REQUESTED')).toBe(false);
  });

  it('allowedTargets lists the reachable states', () => {
    expect(machine.allowedTargets('ACCEPTED').sort()).toEqual(
      ['CANCELLED_BY_DRIVER', 'CANCELLED_BY_RIDER', 'DRIVER_ARRIVED'].sort(),
    );
    expect(machine.allowedTargets('COMPLETED')).toEqual([]);
  });

  it('can() is false rather than throwing', () => {
    expect(machine.can({ ride: ride('COMPLETED'), to: 'IN_PROGRESS', actor: ADMIN_ACTOR }))
      .toBe(false);
  });

  it('accepts a custom rule table, so the table is data rather than hardcoded', () => {
    const custom = new RideStateMachine([
      {
        from: 'REQUESTED',
        to: 'COMPLETED',
        actors: [{ role: 'ADMIN' }],
        description: 'test-only shortcut',
      },
    ]);

    expect(custom.can({ ride: ride('REQUESTED'), to: 'COMPLETED', actor: ADMIN_ACTOR })).toBe(true);
    // And the real table still does not allow it.
    expect(machine.can({ ride: ride('REQUESTED'), to: 'COMPLETED', actor: ADMIN_ACTOR })).toBe(false);
  });

  it('every rule is reachable via a permitted actor', () => {
    for (const rule of TRANSITIONS) {
      const actor = anyPermittedActor(rule.from, rule.to);
      expect(machine.can({ ride: ride(rule.from), to: rule.to, actor })).toBe(true);
    }
  });
});
