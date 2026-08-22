/**
 * The database surface, as a port.
 *
 * CLAUDE.md §3.3 requires all DB access to go through PgBouncer with a hard
 * connection cap, and forbids ad-hoc pools. Making the database a port with one
 * sanctioned implementation is how that is enforced structurally: a service
 * that wants a connection has to be given this, and the only thing that
 * constructs it is the composition root.
 *
 * PgBouncer runs in TRANSACTION pooling mode (see infra/docker-compose.yml),
 * which has a consequence that shapes this whole interface: a connection is
 * only yours for the duration of a transaction. Session state does not survive
 * between statements. That rules out, permanently:
 *
 *   - `SET`/`SET LOCAL` outside a transaction
 *   - session-level advisory locks
 *   - LISTEN / NOTIFY
 *   - prepared statements that outlive a transaction
 *   - temporary tables spanning statements
 *
 * If a future feature seems to need one of those, it needs a different design,
 * not a direct connection.
 */

export type SqlValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | Buffer
  | SqlValue[];

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

/**
 * Anything that can run a query: the pool itself, or a transaction.
 *
 * Repositories take this rather than the pool, so the same repository method
 * works standalone or inside a transaction with no separate code path. That is
 * what makes "the status change and the ledger entries commit together or not
 * at all" (CLAUDE.md §4, §6.2) expressible without duplicating every query.
 */
export interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<QueryResult<Row>>;
}

export interface Transaction extends Queryable {
  /**
   * Register work to run after the transaction COMMITS successfully.
   *
   * Releasing a Redis claim, publishing a realtime event or enqueuing a push
   * must not happen before the commit - if the transaction then rolls back, the
   * rider has been told about a ride that does not exist. Callbacks registered
   * here run only on a successful commit, and their failures are logged rather
   * than thrown, because the transaction is already durable by then.
   */
  onCommit(callback: () => Promise<void> | void): void;
}

export interface Database extends Queryable {
  /**
   * Run `work` inside a single transaction. Commits on return, rolls back on
   * throw. Nested calls join the outer transaction rather than opening a second
   * connection - which under transaction pooling would deadlock against itself.
   */
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;

  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const DATABASE = Symbol('DATABASE');

/**
 * Postgres error codes this codebase reacts to by name rather than by parsing
 * message text, which changes between server versions and locales.
 */
export const PgErrorCode = {
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  CheckViolation: '23514',
  RestrictViolation: '23001',
  SerializationFailure: '40001',
  DeadlockDetected: '40P01',
} as const;

export function isPgError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/** True if the unique violation came from the named constraint. */
export function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  return (
    isPgError(error, PgErrorCode.UniqueViolation) &&
    typeof error === 'object' &&
    error !== null &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint === constraintName
  );
}
