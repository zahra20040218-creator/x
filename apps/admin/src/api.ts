import {
  type AdminSession,
  type DriverDocuments,
  type DriverDocumentType,
  type Dispute,
  type DriverSubscription,
  type SubscriptionPlan,
  createDataProvider,
  fetchDisputes,
  fetchDriverDocuments,
  fetchSubscriptionPlans,
  grantSubscription,
  recordDriverDocument,
  resolveDispute,
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

/** `fetchSubscriptionPlans` with the base URL and session already applied. */
export function subscriptionPlans(): Promise<{ plans: SubscriptionPlan[] }> {
  return fetchSubscriptionPlans(API_BASE_URL, session);
}

/** `grantSubscription` with the base URL and session already applied. */
export function sellSubscription(
  driverId: string,
  body: { planCode: string; chargeIqd?: number; note?: string },
): Promise<DriverSubscription> {
  return grantSubscription(API_BASE_URL, session, driverId, body);
}

/** `fetchDisputes` with the base URL and session already applied. */
export function disputes(
  params: { status?: string; cursor?: string; limit?: number } = {},
): Promise<{ items: Dispute[]; nextCursor?: string | null }> {
  return fetchDisputes(API_BASE_URL, session, params);
}

/** `resolveDispute` with the base URL and session already applied. */
export function closeDispute(
  disputeId: string,
  body: { outcome: 'RESOLVED' | 'REJECTED'; resolution: string },
): Promise<Dispute> {
  return resolveDispute(API_BASE_URL, session, disputeId, body);
}
