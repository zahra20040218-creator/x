import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { iqd } from '../money/iqd.js';
import {
  WaylClient,
  WaylPermanentError,
  WaylTransientError,
  type WaylConfig,
} from './wayl.client.js';

/**
 * The Wayl HTTP client.
 *
 * `fetch` is stubbed rather than a server started: what is worth pinning here
 * is the TRANSLATION — their vocabulary to ours, their errors to retryable or
 * not, their signature scheme to a boolean — and none of that needs a socket.
 *
 * The distinctions asserted below are the ones that cost money when wrong. A
 * transient error retried is a payment eventually collected; a transient error
 * treated as permanent is a driver charged with nothing to show for it. An
 * unknown status read as PAID is a subscription given away.
 */

const CONFIG: WaylConfig = {
  baseUrl: 'https://api.example.test',
  token: 'test-token',
  webhookSecret: 'a-webhook-secret-long-enough-for-hmac',
  testMode: true,
  timeoutMs: 5_000,
};

function respond(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let client: WaylClient;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  client = new WaylClient(CONFIG);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLink', () => {
  it('sends OUR reference and the amount in whole dinars', async () => {
    fetchMock.mockResolvedValue(respond(200, { data: { url: 'https://pay.test/abc', id: 'p_1' } }));

    await client.createLink({
      referenceId: 'ref-1',
      amountIqd: iqd(25_000),
      description: 'ALY subscription',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/api/v1/links');
    const sent = JSON.parse((init as RequestInit).body as string);

    expect(sent.referenceId).toBe('ref-1');
    // 25000, not 2500000. IQD has no circulating subunit, and inventing a
    // "minor unit" would invent a rounding boundary the currency does not have.
    expect(sent.amount).toBe(25_000);
    expect(sent.currency).toBe('IQD');
  });

  it('carries the sandbox flag when test mode is on', async () => {
    fetchMock.mockResolvedValue(respond(200, { data: { url: 'https://pay.test/abc' } }));
    await client.createLink({ referenceId: 'r', amountIqd: iqd(1), description: 'd' });

    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.env).toBe('test');
  });

  it('authenticates with the header the provider expects', async () => {
    fetchMock.mockResolvedValue(respond(200, { data: { url: 'https://pay.test/abc' } }));
    await client.createLink({ referenceId: 'r', amountIqd: iqd(1), description: 'd' });

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-WAYL-AUTHENTICATION']).toBe('test-token');
  });

  it('treats a 200 with no URL as transient, not as success', async () => {
    // The alternative is a row stuck PENDING with nothing for the driver to
    // open, and no reason recorded anywhere.
    fetchMock.mockResolvedValue(respond(200, { data: {} }));

    await expect(
      client.createLink({ referenceId: 'r', amountIqd: iqd(1), description: 'd' }),
    ).rejects.toBeInstanceOf(WaylTransientError);
  });
});

describe('which failures are worth retrying', () => {
  it('treats a network failure as transient', async () => {
    // The request may or may not have reached them, which is exactly why the
    // reference id is generated before the call.
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    await expect(client.getStatus('ref-1')).rejects.toBeInstanceOf(WaylTransientError);
  });

  it('treats 5xx and 429 as transient', async () => {
    for (const status of [500, 502, 503, 429]) {
      fetchMock.mockResolvedValue(respond(status, { error: 'nope' }));
      await expect(client.getStatus('ref-1')).rejects.toBeInstanceOf(WaylTransientError);
    }
  });

  it('treats 4xx as permanent, because the identical request gets the identical answer', async () => {
    // A bad token, a rejected amount, an unknown reference. Retrying one of
    // these is a loop that ends when someone notices.
    for (const status of [400, 401, 403, 404, 422]) {
      fetchMock.mockResolvedValue(respond(status, { error: 'nope' }));
      await expect(client.getStatus('ref-1')).rejects.toBeInstanceOf(WaylPermanentError);
    }
  });

  it('treats a non-JSON body as transient', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>gateway timeout</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    await expect(client.getStatus('ref-1')).rejects.toBeInstanceOf(WaylTransientError);
  });
});

describe('reading a status', () => {
  const cases: Array<[string, string]> = [
    ['paid', 'PAID'],
    ['completed', 'PAID'],
    ['succeeded', 'PAID'],
    ['failed', 'FAILED'],
    ['declined', 'FAILED'],
    ['cancelled', 'FAILED'],
    ['expired', 'EXPIRED'],
    ['refunded', 'REFUNDED'],
  ];

  for (const [remote, expected] of cases) {
    it(`maps "${remote}" to ${expected}`, async () => {
      fetchMock.mockResolvedValue(respond(200, { data: { status: remote } }));
      expect((await client.getStatus('r')).status).toBe(expected);
    });
  }

  it('maps anything it does not recognise to PENDING, never to PAID', async () => {
    // The safe reading of "I do not know" is "not yet": it leaves the row for
    // the next sweep. The alternatives are granting a subscription nobody paid
    // for, or cancelling one somebody did.
    for (const unknown of ['under_review', 'chargeback', 'quantum', '']) {
      fetchMock.mockResolvedValue(respond(200, { data: { status: unknown } }));
      expect((await client.getStatus('r')).status).toBe('PENDING');
    }
  });

  it('reads the fee as a whole-dinar integer', async () => {
    fetchMock.mockResolvedValue(respond(200, { data: { status: 'paid', fee: 1225 } }));
    expect((await client.getStatus('r')).feeIqd).toBe(1225);
  });

  it('reports a missing fee as null rather than zero', async () => {
    // Zero means "they took nothing", which is a claim. Null means "they have
    // not said", which is the truth — and settlement skips the fee entry
    // rather than writing a wrong one.
    fetchMock.mockResolvedValue(respond(200, { data: { status: 'paid' } }));
    expect((await client.getStatus('r')).feeIqd).toBeNull();
  });
});

describe('webhook signatures', () => {
  const body = '{"id":"evt_1","referenceId":"ref-1","status":"paid"}';
  const sign = (raw: string, secret = CONFIG.webhookSecret) =>
    'sha256=' +
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:crypto').createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

  it('accepts a correct signature', () => {
    expect(client.verifyWebhook(body, sign(body))).toBe(true);
  });

  it('accepts it without the sha256= prefix', () => {
    expect(client.verifyWebhook(body, sign(body).slice('sha256='.length))).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(client.verifyWebhook(body, sign(body, 'a-different-secret-entirely'))).toBe(false);
  });

  it('rejects a signature over DIFFERENT bytes', () => {
    // The whole point of signing the raw body. Re-serialising a parsed object
    // reorders keys, and a handler that did so would reject every legitimate
    // request while this test still passed.
    const reordered = '{"referenceId":"ref-1","id":"evt_1","status":"paid"}';
    expect(client.verifyWebhook(body, sign(reordered))).toBe(false);
  });

  it('rejects a missing header rather than treating it as unsigned-and-fine', () => {
    expect(client.verifyWebhook(body, undefined)).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, and an exception here
    // would be a 500 on an unauthenticated endpoint.
    for (const bad of ['', 'not-hex', 'sha256=zzzz', 'sha256=abc']) {
      expect(client.verifyWebhook(body, bad)).toBe(false);
    }
  });
});
