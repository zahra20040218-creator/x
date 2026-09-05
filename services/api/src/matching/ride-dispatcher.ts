import { QUEUE_NAMES, type QueueRegistry, type RideDispatchJob } from '../queue/queues.js';
import type { Logger } from '../common/logger.js';

/**
 * Hands a newly created ride to matching.
 *
 * ## Why this class exists
 *
 * Nothing dispatched a new ride. `POST /rides` created it, returned 201, and no
 * driver was ever offered it — `MatchingService.dispatch` was reachable only
 * from matching's own re-dispatch path (after a decline or an expiry) and from
 * tests. A rider requesting a ride in production would have watched "searching"
 * until they gave up.
 *
 * ## Why it is a queue and not a direct call
 *
 * Dispatch reads platform config, queries the Redis geo set, filters eligible
 * drivers against Postgres, writes a transition and an offer row, and publishes
 * to a socket. Doing that inside the request holds a PgBouncer slot for its
 * whole duration while the rider waits on a response they do not need it for.
 * CLAUDE.md §3.2 is about exactly this. The rider gets 201 immediately and
 * hears about the driver over the realtime channel.
 *
 * ## What happens if the queue is unreachable
 *
 * The ride is still created — losing the dispatch is bad, losing the rider's
 * ride record is worse, and the request has already succeeded by this point.
 * The failure is logged at error level with the ride id so it can be
 * re-dispatched, and `sweepStaleRequests` exists to pick up rides that were
 * never offered.
 */
export class RideDispatcher {
  constructor(
    private readonly queues: QueueRegistry,
    private readonly logger?: Logger,
  ) {}

  /**
   * How long to wait for the enqueue before giving up on it.
   *
   * This is the same hazard `RateLimitGuard` documents and bounds: ioredis
   * BUFFERS commands while disconnected rather than rejecting them, so a Redis
   * that is unreachable does not fail the `add()` - it makes it wait, forever
   * if nothing ever connects. The `catch` below was written for a rejection
   * that, without this, never arrives.
   *
   * The effect was not theoretical. `POST /rides` awaits this, so with Redis
   * down the rider's request hung instead of returning a ride, and every
   * end-to-end test that created a ride timed out rather than failing fast.
   *
   * Three seconds because the rider is on the other end of it. Losing a
   * dispatch is recoverable - the ride exists and `sweepStaleRequests` picks it
   * up - and losing the request is not.
   */
  private static readonly ENQUEUE_TIMEOUT_MS = 3_000;

  async dispatch(rideId: string): Promise<void> {
    const job: RideDispatchJob = { rideId };

    try {
      await this.withTimeout(
        this.queues.get(QUEUE_NAMES.rideDispatch).add(QUEUE_NAMES.rideDispatch, job, {
        // The rider is waiting. A backed-off retry here is worth more than a
        // fast failure, but not more than a few seconds of it.
        attempts: 3,
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: 500,
        // Deduplicates a retry that reached the queue twice; matching itself is
        // idempotent per ride, but not queueing twice is cheaper than relying
        // on that.
        jobId: `dispatch:${rideId}`,
        }),
      );
    } catch (error) {
      // Deliberately not rethrown. The ride exists and the rider has their 201.
      this.logger?.error(
        { event: 'ride.dispatch_enqueue_failed', ride_id: rideId, err: error },
        'could not enqueue dispatch; the ride will not be offered until swept',
      );
    }
  }

  /**
   * Bound a promise in time, without leaking an unhandled rejection.
   *
   * The losing promise keeps a handler attached: a Redis error arriving after
   * the race is decided would otherwise be an unhandled rejection, which takes
   * the process down. Same reasoning, and same shape, as
   * `RateLimitGuard.incrementWithTimeout`.
   */
  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    operation.catch(() => {
      /* handled by the race, or already too late to matter */
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Enqueuing dispatch timed out after ${RideDispatcher.ENQUEUE_TIMEOUT_MS}ms.`,
                ),
              ),
            RideDispatcher.ENQUEUE_TIMEOUT_MS,
          );
          // Must not hold the event loop open at shutdown.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
