import type { Clock } from '../common/clock.js';
import type { Queryable } from '../db/db.port.js';

/**
 * Driver document compliance.
 *
 * Owner decision, 2026-08-24, overriding the CLAUDE.md §2 OUT-OF-SCOPE entry
 * for KYC. See DECISIONS.md and migration 0010.
 *
 * ## Disabled by default, and that is the load-bearing property
 *
 * `required_driver_documents` is empty unless somebody sets it. Empty means
 * every driver is compliant, and means this class issues **no query at all** —
 * so turning the feature off is not a policy that happens to allow everyone, it
 * is the absence of a check.
 *
 * Which documents Iraqi law requires of a ride-hailing driver is not a question
 * this code answers. Guessing would stop real drivers earning on the strength
 * of an assumption, and the failure would look like a bug in matching.
 */

export const DRIVER_DOCUMENT_TYPES = [
  'NATIONAL_ID',
  'DRIVING_LICENCE',
  'VEHICLE_REGISTRATION',
  'VEHICLE_AUTHORIZATION',
] as const;

export type DriverDocumentType = (typeof DRIVER_DOCUMENT_TYPES)[number];

export type DriverDocumentStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

/** Why a driver is not allowed to work. */
export interface ComplianceVerdict {
  readonly compliant: boolean;

  /** Required, but never recorded, or recorded and not yet VERIFIED. */
  readonly missing: readonly DriverDocumentType[];

  /** Verified, but `expires_at` has passed. */
  readonly expired: readonly DriverDocumentType[];

  /** Verified and rejected outright — distinct from never supplied. */
  readonly rejected: readonly DriverDocumentType[];
}

export const COMPLIANT: ComplianceVerdict = {
  compliant: true,
  missing: [],
  expired: [],
  rejected: [],
};

/**
 * Parse the configured requirement list.
 *
 * Unknown names are dropped rather than throwing. The value is edited by an
 * administrator, and a typo should cost that one entry — not take driver
 * matching down for everybody, which is what an exception on this path would
 * do. [onUnknown] exists so the caller can log what was ignored; silently
 * discarding it would make a typo indistinguishable from a policy change.
 */
export function parseRequiredDocuments(
  raw: string,
  onUnknown?: (value: string) => void,
): DriverDocumentType[] {
  const seen = new Set<DriverDocumentType>();

  for (const part of raw.split(',')) {
    const name = part.trim().toUpperCase();
    if (name === '') continue;

    if ((DRIVER_DOCUMENT_TYPES as readonly string[]).includes(name)) {
      seen.add(name as DriverDocumentType);
    } else {
      onUnknown?.(name);
    }
  }

  return [...seen];
}

interface DocumentRow {
  doc_type: DriverDocumentType;
  status: DriverDocumentStatus;
  expires_at: Date | null;
}

export class DriverComplianceService {
  constructor(
    private readonly clock: Clock,
    /**
     * Reads the requirement list. Injected rather than queried here so the
     * caching policy stays in one place and this class stays a pure decision.
     */
    private readonly requiredDocuments: () => Promise<DriverDocumentType[]>,
  ) {}

  /**
   * Whether one driver may work, and what is stopping them.
   *
   * Used on the "go online" path, where the driver is waiting for an answer and
   * needs to be told which document to bring — "you are not eligible" is not
   * something anyone can act on.
   */
  async evaluate(q: Queryable, driverId: string): Promise<ComplianceVerdict> {
    const required = await this.requiredDocuments();
    if (required.length === 0) return COMPLIANT;

    const result = await q.query<DocumentRow>(
      `SELECT doc_type, status, expires_at
         FROM driver_documents
        WHERE driver_id = $1 AND doc_type = ANY($2::driver_document_type[])`,
      [driverId, required as never],
    );

    return this.verdictFor(required, result.rows);
  }

  /**
   * Which of these drivers may be offered a ride.
   *
   * One query for the whole candidate set: matching evaluates several drivers
   * per dispatch, and a query each would put the document table on the hot path
   * once per candidate.
   */
  async filterCompliant(q: Queryable, driverIds: string[]): Promise<Set<string>> {
    if (driverIds.length === 0) return new Set();

    const required = await this.requiredDocuments();
    if (required.length === 0) return new Set(driverIds);

    const result = await q.query<DocumentRow & { driver_id: string }>(
      `SELECT driver_id, doc_type, status, expires_at
         FROM driver_documents
        WHERE driver_id = ANY($1::uuid[])
          AND doc_type = ANY($2::driver_document_type[])`,
      [driverIds as never, required as never],
    );

    const byDriver = new Map<string, DocumentRow[]>();
    for (const row of result.rows) {
      const rows = byDriver.get(row.driver_id);
      if (rows) rows.push(row);
      else byDriver.set(row.driver_id, [row]);
    }

    // Default to an empty document set, so a driver with no rows at all is
    // non-compliant rather than absent from the loop and silently allowed.
    return new Set(
      driverIds.filter(
        (id) => this.verdictFor(required, byDriver.get(id) ?? []).compliant,
      ),
    );
  }

  private verdictFor(
    required: readonly DriverDocumentType[],
    rows: readonly DocumentRow[],
  ): ComplianceVerdict {
    const held = new Map(rows.map((row) => [row.doc_type, row]));

    const missing: DriverDocumentType[] = [];
    const expired: DriverDocumentType[] = [];
    const rejected: DriverDocumentType[] = [];

    for (const type of required) {
      const row = held.get(type);

      if (!row || row.status === 'PENDING') {
        missing.push(type);
        continue;
      }

      if (row.status === 'REJECTED') {
        // Separate from missing: the driver has been told why, and supplying
        // the same document again will not help.
        rejected.push(type);
        continue;
      }

      if (this.hasExpired(row.expires_at)) expired.push(type);
    }

    return {
      compliant: missing.length === 0 && expired.length === 0 && rejected.length === 0,
      missing,
      expired,
      rejected,
    };
  }

  /**
   * A document expires at the END of its printed date.
   *
   * A licence dated 2026-08-24 is valid all through the 24th; treating the
   * date as an instant would stop a driver working from midnight on a day
   * their document is still good. The column is a DATE, which pg returns as
   * local midnight, so the comparison is against the day after.
   */
  private hasExpired(expiresAt: Date | null): boolean {
    if (expiresAt === null) return false; // No expiry recorded: does not lapse.

    const endOfDay = new Date(expiresAt);
    endOfDay.setDate(endOfDay.getDate() + 1);

    return this.clock.now().getTime() >= endOfDay.getTime();
  }
}
