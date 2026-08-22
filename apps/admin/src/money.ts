/**
 * Money formatting for the admin panel.
 *
 * `ACCEPTANCE_CHECKLIST.md` check 6 asks the owner to look at this panel and
 * confirm that no amount shows a decimal fraction. That check is only
 * meaningful if the panel would actually SHOW one — so this module never
 * rounds, truncates, or `toFixed()`s a value into looking correct.
 *
 * If the server ever sends a fractional amount, `formatIqd` renders it as a
 * visible anomaly rather than hiding it. A panel that quietly rounded would
 * turn check 6 into a test that always passes.
 */

const grouped = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function isWholeIqd(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * `12500` -> `12,500 د.ع`
 *
 * A non-integer is rendered with a loud marker rather than rounded away.
 */
export function formatIqd(value: unknown): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';

  if (!Number.isInteger(value)) {
    // Deliberately ugly. This is a P0 (CLAUDE.md §6.1) and the panel's job is
    // to make it impossible to miss during check 6.
    return `⚠ ${value} د.ع (NOT A WHOLE DINAR)`;
  }

  return `${grouped.format(value)} د.ع`;
}

/** Sum a column, refusing to produce a total from non-integer inputs. */
export function sumIqd(values: readonly unknown[]): number | null {
  let total = 0;
  for (const value of values) {
    if (!isWholeIqd(value)) return null;
    total += value;
  }
  return total;
}

/** Baghdad time, for a panel operated from Baghdad (CLAUDE.md §8). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Baghdad',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(iso));
}
