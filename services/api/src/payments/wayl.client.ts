import { createHmac, timingSafeEqual } from 'node:crypto';

import { iqd, type IqdAmount } from '../money/iqd.js';

/**
 * The Wayl HTTP client.
 *
 * A thin, total translation of one company's API into this codebase's types,
 * and nothing else. It does not touch the database, does not write the ledger,
 * and does not decide anything — so every question about whether a payment is
 * real is answered somewhere that can be tested without a network.
 *
 * ## Where it may be called from
 *
 * A BullMQ job, never a request handler. CLAUDE.md §3.2 forbids awaiting a
 * third-party HTTP call while holding a request, and this one is worse than
 * most: creating a checkout link is a foreign round trip on the path a driver
 * is staring at, and on a 4-core VPS it holds a connection-pool slot the whole
 * time (§3.3).
 *
 * ## Timeouts are not optional
 *
 * Every call is bounded. A provider that hangs rather than refusing is the
 * failure mode that took this repository's own `POST /rides` down for sixteen
 * end-to-end tests — ioredis buffered instead of rejecting and the `catch` was
 * never reached. The same shape of bug with an external company is worse,
 * because nothing about their availability is under anyone's control here.
 */

export interface WaylConfig {
  baseUrl: string;
  /** `X-WAYL-AUTHENTICATION`. Server-side only — never in a client bundle. */
  token: string;
  /** HMAC-SHA256 shared secret for `x-wayl-signature-256`. */
  webhookSecret: string;
  /** Wayl's sandbox flag. Requests carry `env=test` when true. */
  testMode: boolean;
  timeoutMs: number;
}

export interface CreateLinkInput {
  /** OUR reference, generated before the call. See migration 0016. */
  referenceId: string;
  amountIqd: IqdAmount;
  description: string;
  /** Where the provider sends the payer back to. */
  redirectUrl?: string;
}

export interface CreateLinkResult {
  checkoutUrl: string;
  providerRef: string | null;
  expiresAt: Date | null;
}

export type RemoteStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED';

export interface LinkStatus {
  status: RemoteStatus;
  /** What the provider kept. Null until they report it. */
  feeIqd: IqdAmount | null;
  providerRef: string | null;
  paidAt: Date | null;
}

/** A call that failed in a way worth retrying — network, timeout, 5xx. */
export class WaylTransientError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'WaylTransientError';
  }
}

/** A call the provider refused and will refuse again. Retrying is pointless. */
export class WaylPermanentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'WaylPermanentError';
  }
}

export class WaylClient {
  constructor(private readonly config: WaylConfig) {}

  /**
   * Open a hosted checkout.
   *
   * The amount is sent in whole dinars, matching how it is stored. IQD has no
   * practically-used subunit and CLAUDE.md §6.1 makes money an integer
   * everywhere; multiplying by 100 for a "minor unit" that does not circulate
   * would invent a rounding boundary the currency does not have.
   */
  async createLink(input: CreateLinkInput): Promise<CreateLinkResult> {
    const body = await this.request<{
      data?: { url?: string; id?: string; expiresAt?: string };
    }>('POST', '/api/v1/links', {
      referenceId: input.referenceId,
      amount: input.amountIqd,
      currency: 'IQD',
      description: input.description,
      ...(input.redirectUrl ? { redirectionUrl: input.redirectUrl } : {}),
      ...(this.config.testMode ? { env: 'test' } : {}),
    });

    const url = body.data?.url;
    if (typeof url !== 'string' || url.length === 0) {
      // A 200 with no link is not a success. Treated as transient so the job
      // retries: the alternative is a row stuck PENDING with nothing to open.
      throw new WaylTransientError('Wayl accepted the request but returned no checkout URL.');
    }

    return {
      checkoutUrl: url,
      providerRef: body.data?.id ?? null,
      expiresAt: parseDate(body.data?.expiresAt),
    };
  }

  /**
   * Ask what happened to a checkout.
   *
   * This is the authoritative path, not the webhook. A webhook that never
   * arrives leaves money collected and a subscription ungranted; polling
   * cannot miss, because it asks.
   */
  async getStatus(referenceId: string): Promise<LinkStatus> {
    const body = await this.request<{
      data?: { status?: string; fee?: number; id?: string; paidAt?: string };
    }>('GET', `/api/v1/links/${encodeURIComponent(referenceId)}`);

    return {
      status: mapStatus(body.data?.status),
      // Through `iqd()`, not a cast. This is another company's number arriving
      // as JSON, and a fractional fee must be refused rather than rounded into
      // an append-only ledger (§6.1).
      feeIqd: typeof body.data?.fee === 'number' ? iqd(Math.round(body.data.fee)) : null,
      providerRef: body.data?.id ?? null,
      paidAt: parseDate(body.data?.paidAt),
    };
  }

  /** Refund a settled payment. Wayl charges for this; the caller books it. */
  async refund(providerRef: string, amountIqd: IqdAmount): Promise<{ refundRef: string | null }> {
    const body = await this.request<{ data?: { id?: string } }>('POST', '/api/v1/refunds', {
      paymentId: providerRef,
      amount: amountIqd,
    });
    return { refundRef: body.data?.id ?? null };
  }

  /**
   * Verify a webhook signature.
   *
   * Over the RAW bytes, with `timingSafeEqual`. Parsing and re-serialising
   * reorders keys and the signature would never match a legitimate request; a
   * `===` on the digest leaks the correct value one byte at a time to anyone
   * who can measure a response.
   *
   * ## The limitation, stated plainly
   *
   * Wayl's signature carries NO timestamp, so a captured request stays valid
   * forever. This function cannot fix that — freshness has to come from
   * somewhere with a clock and a database, which is why every accepted webhook
   * is deduplicated on its event id in `payment_webhook_events` before it is
   * allowed to write anything.
   */
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;

    const provided = signatureHeader.startsWith('sha256=')
      ? signatureHeader.slice('sha256='.length)
      : signatureHeader;
    if (!/^[0-9a-f]+$/i.test(provided)) return false;

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(rawBody, 'utf8')
      .digest('hex');

    const a = Buffer.from(provided.toLowerCase(), 'hex');
    const b = Buffer.from(expected, 'hex');
    // `timingSafeEqual` throws on a length mismatch, which is itself a timing
    // signal. Compare lengths first and fail uniformly.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // -------------------------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-WAYL-AUTHENTICATION': this.config.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // Abort, DNS, connection reset. All transient by nature: the request may
      // or may not have reached them, which is exactly why the reference id is
      // generated before the call.
      throw new WaylTransientError(`Wayl ${method} ${path} did not complete.`, error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 500 || response.status === 429) {
      throw new WaylTransientError(`Wayl ${method} ${path} answered ${response.status}.`);
    }

    if (!response.ok) {
      // 4xx. A bad token, a rejected amount, an unknown reference - retrying
      // sends the identical request and gets the identical refusal.
      const detail = await response.text().catch(() => '');
      throw new WaylPermanentError(
        `Wayl ${method} ${path} refused with ${response.status}: ${detail.slice(0, 200)}`,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new WaylTransientError(`Wayl ${method} ${path} returned a body that is not JSON.`);
    }
  }
}

/**
 * Their vocabulary to ours.
 *
 * Anything unrecognised maps to PENDING, never to PAID or FAILED. An unknown
 * status is a status this build has not been taught, and the safe reading of
 * "I do not know" is "not yet" - which leaves the row for the next sweep. The
 * alternatives are granting a subscription nobody paid for, or cancelling one
 * somebody did.
 */
function mapStatus(raw: string | undefined): RemoteStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'paid':
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'PAID';
    case 'failed':
    case 'declined':
    case 'cancelled':
    case 'canceled':
      return 'FAILED';
    case 'expired':
      return 'EXPIRED';
    case 'refunded':
      return 'REFUNDED';
    default:
      return 'PENDING';
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
