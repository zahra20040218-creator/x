import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

import type { Logger } from '../common/logger.js';

/**
 * Async work. CLAUDE.md §3.2:
 *
 *   "No synchronous external calls in a request handler. Maps/routing, FCM
 *    push, SMS — all go through a BullMQ queue. A request handler that awaits
 *    a third-party HTTP call is a defect."
 *
 * The rule is about tail latency, not tidiness. On a 4-core box a handler
 * awaiting a 2-second FCM call holds a connection from a 25-slot PgBouncer pool
 * for those two seconds. At 500 concurrent users that is the whole pool, and
 * the symptom is not "push is slow" — it is every request timing out.
 */

export const QUEUE_NAMES = {
  push: 'push',
  /**
   * Offer a newly created ride to a driver.
   *
   * Queued rather than run inside `POST /rides` for the reason in the header:
   * dispatch touches Postgres and Redis several times, and holding a pool slot
   * for it while the rider waits on the response is how a 25-slot pool empties
   * at 500 users. The rider gets their 201 immediately and hears about the
   * driver over the socket.
   */
  rideDispatch: 'ride-dispatch',
  locationFlush: 'location-flush',
  offerSweep: 'offer-sweep',
  presenceSweep: 'presence-sweep',
  idempotencyPurge: 'idempotency-purge',
  /**
   * Close subscription periods whose date has passed.
   *
   * Hourly, not by the minute: the capability check compares `expires_at` to
   * the clock and ignores the status column precisely so a late sweep can
   * never let a lapsed driver work. This only keeps the column honest for
   * things that read it directly - the admin panel, and the partial unique
   * index that would otherwise refuse a renewal against an unclosed period.
   */
  subscriptionExpiry: 'subscription-expiry',
  /**
   * Close bids whose window has passed.
   *
   * Every 30s, not hourly: `negotiation_window_seconds` defaults to 90, so a
   * slower sweep would leave a rider looking at bids that can no longer be
   * accepted - and the accept path would refuse them with a conflict the
   * rider has no way to have predicted.
   */
  bidExpiry: 'bid-expiry',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface RideDispatchJob {
  rideId: string;
}

export interface PushJob {
  userId: string;
  role: 'RIDER' | 'DRIVER';
  title: string;
  body: string;
  data: Record<string, string>;
}

export function createConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
  };
}

export class QueueRegistry {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly connection: ConnectionOptions) {}

  get(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: {
          // Push to a phone that is off will fail; three tries with backoff is
          // the difference between a delivered offer and a missed one.
          attempts: 3,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Fire-and-forget. Never awaited on the request path beyond the enqueue. */
  async enqueuePush(job: PushJob): Promise<void> {
    await this.get(QUEUE_NAMES.push).add('send', job);
  }

  /**
   * Register the repeating maintenance jobs.
   *
   * The 30s location flush is mandated by CLAUDE.md §3.1; the others exist
   * because state that only converges when someone calls an endpoint does not
   * converge at 3am.
   */
  async scheduleRecurring(locationFlushMs: number): Promise<void> {
    await this.get(QUEUE_NAMES.locationFlush).add(
      'flush',
      {},
      { repeat: { every: locationFlushMs }, jobId: 'location-flush' },
    );
    await this.get(QUEUE_NAMES.offerSweep).add(
      'sweep',
      {},
      { repeat: { every: 5_000 }, jobId: 'offer-sweep' },
    );
    await this.get(QUEUE_NAMES.presenceSweep).add(
      'sweep',
      {},
      { repeat: { every: 30_000 }, jobId: 'presence-sweep' },
    );
    await this.get(QUEUE_NAMES.idempotencyPurge).add(
      'purge',
      {},
      { repeat: { every: 3_600_000 }, jobId: 'idempotency-purge' },
    );

    await this.get(QUEUE_NAMES.subscriptionExpiry).add(
      'sweep',
      {},
      { repeat: { every: 3_600_000 }, jobId: 'subscription-expiry' },
    );

    await this.get(QUEUE_NAMES.bidExpiry).add(
      'sweep',
      {},
      { repeat: { every: 30_000 }, jobId: 'bid-expiry' },
    );
  }

  async close(): Promise<void> {
    for (const queue of this.queues.values()) await queue.close();
    this.queues.clear();
  }
}

export function createWorker(
  name: QueueName,
  connection: ConnectionOptions,
  handler: (job: Job) => Promise<void>,
  logger?: Logger,
): Worker {
  const worker = new Worker(name, handler, { connection, concurrency: 4 });

  worker.on('failed', (job, error) => {
    logger?.warn(
      { event: 'queue.job_failed', queue: name, job_id: job?.id, err: error },
      'queue job failed',
    );
  });

  return worker;
}
