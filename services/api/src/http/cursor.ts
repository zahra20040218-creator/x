import { ValidationProblem } from '../common/problem.js';

/**
 * Keyset cursors.
 *
 * ## Why a timestamp is not a cursor
 *
 * The obvious cursor is the last row's timestamp, with the next page asking for
 * `created_at < cursor`. It is wrong three times over, and every one of them
 * needs a real PostgreSQL to see:
 *
 *   1. `ORDER BY created_at DESC` is not a total order, so rows sharing a
 *      timestamp come back in whatever order the plan produces and page
 *      boundaries are not stable between requests.
 *
 *   2. `created_at < cursor` excludes every row at that instant — not only the
 *      ones already served. Whatever remained of the group is skipped. Ties are
 *      not an edge case: `now()` is the TRANSACTION timestamp, and a
 *      double-entry ledger writes its rows in one transaction by definition
 *      (CLAUDE.md §6.2), so a settlement's rows always share a `created_at`.
 *
 *   3. `timestamptz` is microsecond precision and a JavaScript `Date` is
 *      millisecond. A timestamp that goes out through JSON and comes back has
 *      been truncated — `12:42:13.511974` returns as `12:42:13.511` — so the
 *      cursor no longer matches the row it was taken from. Ordering by the
 *      tuple does not save this: the truncated value sorts BEFORE every row at
 *      that instant, and the next page comes back empty.
 *
 * So the cursor is the last row's **id**, and the server resolves its position
 * itself:
 *
 *   WHERE (created_at, id) < (SELECT created_at, id FROM t WHERE id = $cursor)
 *   ORDER BY created_at DESC, id DESC
 *
 * a total order, comparing values that never left the database. The extra
 * lookup is by primary key.
 *
 * The id is opaque to the client, which is the point — the cursor is a
 * position, not a value they should construct or reason about.
 */

/**
 * UUID today. Validated rather than trusted because the value is interpolated
 * into a `::uuid` cast, and a malformed one should be a 422 naming the field
 * rather than a driver-level error surfacing as a 500.
 */
const CURSOR_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a cursor a client sent back.
 *
 * A malformed cursor is a bad field, so it is the same RFC 9457 validation
 * problem as any other (CLAUDE.md §9) — not a 500, and not silently ignored,
 * which would restart the listing from the top and look to the user like
 * duplicated rows.
 */
export function decodeKeysetCursor(raw: string): string {
  if (!CURSOR_PATTERN.test(raw)) {
    throw new ValidationProblem([
      { path: 'cursor', message: 'Malformed pagination cursor.' },
    ]);
  }
  return raw;
}

/**
 * The cursor for the next page, or null when this page is the last one.
 *
 * Centralised because the "is there more?" test is easy to get subtly wrong: a
 * short page means the end, and returning a cursor for it makes the client
 * fetch one empty page before it stops.
 */
export function nextKeysetCursor(
  rows: ReadonlyArray<{ id: string }>,
  limit: number,
): string | null {
  if (rows.length < limit) return null;
  return rows.at(-1)?.id ?? null;
}
