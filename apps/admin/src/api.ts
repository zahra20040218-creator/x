import {
  type AdminSession,
  type DriverDocuments,
  type DriverDocumentType,
  createDataProvider,
  fetchDriverDocuments,
  recordDriverDocument,
  topUpWallet,
} from './data-provider';

/**
 * The one place that owns the API base URL and the live session.
 *
 * `session` is a mutable object rather than a value on purpose: the data
 * provider and the auth provider are both constructed once at startup and both
 * close over it, so a token refresh has to be visible to code that captured
 * the reference minutes earlier. Passing the token by value would leave the
 * data provider holding an expired one after every refresh.
 */

export const session: AdminSession = { accessToken: null };

export const API_BASE_URL: string =
  (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? '/v1';

export const dataProvider = createDataProvider(API_BASE_URL, session);

/** `topUpWallet` with the base URL and session already applied. */
export function topUp(
  driverId: string,
  amountIqd: number,
  reference: string,
  idempotencyKey: string,
): Promise<{ driverId: string; balanceIqd: number }> {
  return topUpWallet(API_BASE_URL, session, driverId, amountIqd, idempotencyKey, reference);
}

/** `fetchDriverDocuments` with the base URL and session already applied. */
export function driverDocuments(driverId: string): Promise<DriverDocuments> {
  return fetchDriverDocuments(API_BASE_URL, session, driverId);
}

/** `recordDriverDocument` with the base URL and session already applied. */
export function saveDriverDocument(
  driverId: string,
  docType: DriverDocumentType,
  body: { status: 'PENDING' | 'VERIFIED' | 'REJECTED'; reference?: string; expiresAt?: string; note?: string },
): Promise<DriverDocuments> {
  return recordDriverDocument(API_BASE_URL, session, driverId, docType, body);
}
