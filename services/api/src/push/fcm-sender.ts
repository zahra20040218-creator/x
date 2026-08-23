import { SignJWT, importPKCS8 } from 'jose';

import type { Clock } from '../common/clock.js';
import type { Logger } from '../common/logger.js';
import type { PushMessage, PushOutcome, PushSender } from './push.port.js';

/**
 * FCM HTTP v1.
 *
 * ## Why not `firebase-admin`
 *
 * Because this codebase already declined it once, for the same reason. Token
 * verification uses Google's public JWKS through `jose` rather than the admin
 * SDK, and that decision is worth keeping: `firebase-admin` pulls a large
 * dependency tree including gRPC into an image that runs on a 4-core VPS, to
 * do two things this file does in a hundred lines — mint a service-account
 * JWT, and POST some JSON.
 *
 * ## The access token
 *
 * FCM v1 wants an OAuth2 bearer token, obtained by signing a JWT with the
 * service account's private key and exchanging it at Google's token endpoint.
 * The result is cached until shortly before expiry, because doing that
 * exchange per notification would double the latency of every send and hit
 * Google's rate limits during a dispatch burst.
 */

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * FCM error codes that mean "this token is dead, stop using it".
 *
 * Deliberately a closed list. Treating any unrecognised error as permanent
 * would revoke real devices during an incident, so anything not named here is
 * reported as a transient failure and the token survives.
 */
const PERMANENT_FAILURES = new Set([
  'UNREGISTERED',
  'INVALID_ARGUMENT',
  'SENDER_ID_MISMATCH',
]);

export function parseServiceAccount(json: string): ServiceAccount {
  const parsed = JSON.parse(json) as Record<string, unknown>;

  const projectId = parsed['project_id'];
  const clientEmail = parsed['client_email'];
  const privateKey = parsed['private_key'];

  if (
    typeof projectId !== 'string' ||
    typeof clientEmail !== 'string' ||
    typeof privateKey !== 'string'
  ) {
    throw new Error(
      'FCM service account JSON must contain project_id, client_email and private_key.',
    );
  }

  return {
    projectId,
    clientEmail,
    // Environment variables cannot carry real newlines, so the key arrives
    // with literal \n sequences. Without this the PEM parse fails with an
    // error that says nothing about the actual problem.
    privateKey: privateKey.replace(/\\n/g, '\n'),
  };
}

export class FcmSender implements PushSender {
  private cachedToken: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly clock: Clock,
    private readonly logger?: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(messages: readonly PushMessage[]): Promise<PushOutcome[]> {
    if (messages.length === 0) return [];

    let accessToken: string;
    try {
      accessToken = await this.accessToken();
    } catch (error) {
      // Could not authenticate at all. Every token is a TRANSIENT failure -
      // our credentials being wrong says nothing about whether the devices
      // are still valid, and marking them invalid would delete the fleet.
      this.logger?.error(
        { event: 'push.auth_failed', err: error },
        'could not obtain an FCM access token',
      );
      return messages.map((message) => ({
        token: message.token,
        status: 'failed' as const,
        reason: 'AUTH_FAILED',
      }));
    }

    // One request per token. FCM v1 removed multicast, and `sendEach` in the
    // admin SDK is this loop. Sent concurrently so a slow device does not
    // serialise a dispatch burst.
    return Promise.all(messages.map((message) => this.sendOne(message, accessToken)));
  }

  private async sendOne(message: PushMessage, accessToken: string): Promise<PushOutcome> {
    const url = `https://fcm.googleapis.com/v1/projects/${this.account.projectId}/messages:send`;

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: {
              // Ride offers expire in seconds. `high` is what wakes a device
              // that Android has put to sleep - a normal-priority message can
              // be held until the next maintenance window, by which time the
              // offer has already gone to another driver.
              priority: 'high',
              notification: { sound: 'default' },
            },
          },
        }),
      });

      if (response.ok) {
        return { token: message.token, status: 'delivered' };
      }

      const problem = (await response.json().catch(() => null)) as {
        error?: { status?: string; message?: string; details?: { errorCode?: string }[] };
      } | null;

      const code =
        problem?.error?.details?.find((d) => d.errorCode)?.errorCode ??
        problem?.error?.status ??
        `HTTP_${response.status}`;

      // 404 from this endpoint means the token is gone, which FCM also
      // signals as UNREGISTERED. Both are permanent.
      const permanent = PERMANENT_FAILURES.has(code) || response.status === 404;

      return permanent
        ? { token: message.token, status: 'invalid', reason: code }
        : { token: message.token, status: 'failed', reason: code };
    } catch (error) {
      // Network-level failure. Transient by definition.
      return {
        token: message.token,
        status: 'failed',
        reason: error instanceof Error ? error.name : 'NETWORK',
      };
    }
  }

  /** Cached until 60s before expiry. */
  private async accessToken(): Promise<string> {
    const now = this.clock.nowMs();
    if (this.cachedToken && this.cachedToken.expiresAtMs > now + 60_000) {
      return this.cachedToken.value;
    }

    const key = await importPKCS8(this.account.privateKey, 'RS256');
    const issuedAt = Math.floor(now / 1_000);

    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.account.clientEmail)
      .setSubject(this.account.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3_600)
      .sign(key);

    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`FCM token exchange failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string') {
      throw new Error('FCM token exchange returned no access_token.');
    }

    this.cachedToken = {
      value: body.access_token,
      expiresAtMs: now + (body.expires_in ?? 3_600) * 1_000,
    };

    return this.cachedToken.value;
  }
}
