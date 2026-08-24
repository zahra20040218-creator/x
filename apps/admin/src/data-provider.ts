import type { DataProvider } from '@refinedev/core';

/**
 * Refine data provider over the admin API.
 *
 * Every path here appears in `docs/api-contract.yaml` (CLAUDE.md §12.1). Refine
 * would happily invent REST paths from a resource name; that is exactly what
 * §12.1 forbids, so the mapping is explicit and a resource with no contract
 * entry throws rather than guessing a URL.
 */

const RESOURCE_PATHS: Record<string, string> = {
  drivers: '/admin/drivers',
  rides: '/admin/rides',
  disputes: '/admin/disputes',
  config: '/admin/config',
};

function pathFor(resource: string): string {
  const path = RESOURCE_PATHS[resource];
  if (!path) {
    throw new Error(
      `No contract path for resource "${resource}". Add it to ` +
        `docs/api-contract.yaml first (CLAUDE.md §12.1), then map it here.`,
    );
  }
  return path;
}

export interface AdminSession {
  accessToken: string | null;
}

export function createDataProvider(
  baseUrl: string,
  session: AdminSession,
): DataProvider {
  async function request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(session.accessToken
          ? { Authorization: `Bearer ${session.accessToken}` }
          : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      // RFC 9457 problem+json. Surfacing `detail` rather than a generic
      // message is what lets an operator see "A driver already exists for that
      // phone number" instead of "Request failed".
      const problem = (await response.json().catch(() => null)) as {
        detail?: string;
        title?: string;
      } | null;

      throw new Error(
        problem?.detail ?? problem?.title ?? `Request failed (${response.status})`,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    getApiUrl: () => baseUrl,

    getList: async ({ resource, pagination, filters }) => {
      const params = new URLSearchParams();
      params.set('limit', String(pagination?.pageSize ?? 25));

      for (const filter of filters ?? []) {
        if ('field' in filter && filter.value != null) {
          params.set(filter.field, String(filter.value));
        }
      }

      const json = await request<{ items: unknown[]; nextCursor: string | null }>(
        `${pathFor(resource)}?${params.toString()}`,
      );

      return {
        data: json.items as never,
        // The API is cursor-paginated, so there is no true total. Reporting the
        // page length is honest; inventing a total would make the pager lie.
        total: json.items.length,
      };
    },

    getOne: async ({ resource, id }) => ({
      data: (await request(`${pathFor(resource)}/${String(id)}`)),
    }),

    create: async ({ resource, variables }) => ({
      data: (await request(pathFor(resource), {
        method: 'POST',
        body: JSON.stringify(variables),
      })),
    }),

    update: async ({ resource, id, variables }) => ({
      data: (await request(`${pathFor(resource)}/${String(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(variables),
      })),
    }),

    // CLAUDE.md §6.3 and §12.3: nothing in this panel deletes anything. A
    // driver is SUSPENDED, a dispute is RESOLVED, a ledger row is never
    // touched. Leaving this unimplemented means a stray delete button in a
    // future screen fails loudly instead of destroying an audit trail.
    deleteOne: () => {
      throw new Error(
        'Deletion is not supported. Records are suspended or resolved, never ' +
          'removed (CLAUDE.md §6.3, §12.3).',
      );
    },

    custom: async ({ url, method, payload, headers }) => ({
      data: (await request(url, {
        method: (method ?? 'get').toUpperCase(),
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        ...(headers ? { headers: headers as Record<string, string> } : {}),
      })),
    }),
  };
}

/**
 * Top up a driver wallet.
 *
 * Separate from the generic provider because it REQUIRES an Idempotency-Key
 * (CLAUDE.md §5.2). An operator double-clicking "top up" on a slow connection
 * must not credit twice - the checklist's check 6 tests exactly this.
 */
export async function topUpWallet(
  baseUrl: string,
  session: AdminSession,
  driverId: string,
  amountIqd: number,
  idempotencyKey: string,
  reference?: string,
): Promise<{ driverId: string; balanceIqd: number }> {
  if (!Number.isInteger(amountIqd) || amountIqd <= 0) {
    // Caught here as well as at the server boundary, so the operator sees the
    // problem before the round trip.
    throw new Error('Top-up amount must be a whole number of dinars.');
  }

  const response = await fetch(
    `${baseUrl}/admin/drivers/${driverId}/wallet/topup`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        ...(session.accessToken
          ? { Authorization: `Bearer ${session.accessToken}` }
          : {}),
      },
      body: JSON.stringify({ amountIqd, reference }),
    },
  );

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(problem?.detail ?? `Top-up failed (${response.status})`);
  }

  return (await response.json()) as { driverId: string; balanceIqd: number };
}

export const DRIVER_DOCUMENT_TYPES = [
  'NATIONAL_ID',
  'DRIVING_LICENCE',
  'VEHICLE_REGISTRATION',
  'VEHICLE_AUTHORIZATION',
] as const;

export type DriverDocumentType = (typeof DRIVER_DOCUMENT_TYPES)[number];

export interface DriverDocument {
  docType: DriverDocumentType;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  reference: string;
  expiresAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  note: string;
  updatedAt: string;
}

export interface ComplianceVerdict {
  compliant: boolean;
  missing: DriverDocumentType[];
  expired: DriverDocumentType[];
  rejected: DriverDocumentType[];
}

export interface DriverDocuments {
  items: DriverDocument[];
  compliance: ComplianceVerdict;
}

async function adminRequest<T>(
  baseUrl: string,
  session: AdminSession,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(session.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(problem?.detail ?? `Request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

/** Documents on file for a driver, with a verdict computed at request time. */
export function fetchDriverDocuments(
  baseUrl: string,
  session: AdminSession,
  driverId: string,
): Promise<DriverDocuments> {
  return adminRequest<DriverDocuments>(
    baseUrl,
    session,
    `/admin/drivers/${driverId}/documents`,
  );
}

/**
 * Record the outcome of checking one document.
 *
 * PUT: one record per (driver, type), so re-checking a renewed licence updates
 * it rather than leaving two rows with no rule for which is current.
 */
export function recordDriverDocument(
  baseUrl: string,
  session: AdminSession,
  driverId: string,
  docType: DriverDocumentType,
  body: {
    status: DriverDocument['status'];
    reference?: string;
    expiresAt?: string;
    note?: string;
  },
): Promise<DriverDocuments> {
  return adminRequest<DriverDocuments>(
    baseUrl,
    session,
    `/admin/drivers/${driverId}/documents/${docType}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}
