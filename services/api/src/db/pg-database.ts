import { AsyncLocalStorage } from 'node:async_hooks';

import pg from 'pg';

import type {
  Database,
  QueryResult,
  Queryable,
  SqlValue,
  Transaction,
} from './db.port.js';

const { Pool, types } = pg;

/**
 * node-postgres parses int8 (BIGINT) into a JavaScript number by default in
 * some configurations, which silently loses precision above 2^53. Forcing it to
 * a string means money always arrives as text and must go through
 * `parseIqdFromDb`, which validates it. This is a global registration and it is
 * deliberate: there is no BIGINT column in this schema that should be handled
 * any other way.
 */
types.setTypeParser(types.builtins.INT8, (value: string) => value);

/**
 * `numeric` should never appear in this schema (CLAUDE.md §6.1 forbids it for
 * money), but if one is ever introduced by accident, returning a string rather
 * than a float makes it fail loudly at `parseIqdFromDb` instead of quietly
 * becoming an approximate number.
 */
types.setTypeParser(types.builtins.NUMERIC, (value: string) => value);

/**
 * The one sanctioned Database implementation (CLAUDE.md §3.3).
 *
 * Connects through PgBouncer in transaction pooling mode, which is why:
 *
 *  - the pool is small and hard-capped (PgBouncer, not this pool, absorbs
 *    connection churn; a large client pool just moves the queue),
 *  - nested `transaction()` calls JOIN the outer transaction rather than taking
 *    a second connection. Taking a second one from a pool of N while holding
 *    one is how a service deadlocks against itself under load - every
 *    connection held by a caller waiting for a connection.
 */
export class PgDatabase implements Database {
  private readonly pool: pg.Pool;

  /**
   * Tracks the transaction in scope for the current async context, so that a
   * repository called inside `transaction()` uses that connection without the
   * caller having to thread it through every signature.
   */
  private readonly activeTransaction = new AsyncLocalStorage<TransactionContext>();

  constructor(options: { connectionString: string; maxConnections: number }) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // PgBouncer in transaction mode does not support the extended protocol's
      // named prepared statements across transactions.
      statement_timeout: 15_000,
      query_timeout: 15_000,
    });

    // An idle client erroring (server restart, PgBouncer reload) emits on the
    // pool. Without a listener, Node treats it as an unhandled 'error' event
    // and kills the process.
    this.pool.on('error', () => {
      // Intentionally swallowed here; the pool discards the client and the next
      // query gets a fresh one. Logging happens at the call site with request
      // context attached.
    });
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<Row>> {
    const active = this.activeTransaction.getStore();
    if (active) return active.tx.query<Row>(sql, params);

    const result = await this.pool.query(sql, params as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const existing = this.activeTransaction.getStore();
    // Join the outer transaction. Opening a second connection here would be a
    // self-deadlock risk, and would also break atomicity: the inner work could
    // commit while the outer rolled back.
    if (existing) return work(existing.tx);

    const client = await this.pool.connect();
    const callbacks: Array<() => Promise<void> | void> = [];

    const tx: Transaction = {
      async query<Row = Record<string, unknown>>(
        sql: string,
        params: readonly SqlValue[] = [],
      ): Promise<QueryResult<Row>> {
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      },
      onCommit(callback) {
        callbacks.push(callback);
      },
    };

    try {
      await client.query('BEGIN');
      const result = await this.activeTransaction.run({ tx }, () => work(tx));
      await client.query('COMMIT');

      // After COMMIT, never before. Publishing a realtime event or releasing a
      // claim before the commit means telling a rider about a ride that may
      // still roll back.
      for (const callback of callbacks) {
        try {
          await callback();
        } catch {
          // The transaction is already durable. A failed side effect must not
          // turn a committed ride into an error the caller sees.
        }
      }

      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already broken; the pool will discard it.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface TransactionContext {
  tx: Transaction;
}

/** A Queryable that always runs against the given transaction. */
export function queryableOf(tx: Transaction): Queryable {
  return tx;
}
