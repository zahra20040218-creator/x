/**
 * Push delivery.
 *
 * A port rather than a direct FCM call, for the same reason the payment
 * provider is a port: the delivery mechanism is the part most likely to change
 * (FCM today, possibly a second channel later for drivers on devices without
 * Play Services, which is not rare in Iraq), and the part that must be
 * substitutable in tests.
 */

export type DevicePlatform = 'ANDROID' | 'IOS';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /**
   * FCM requires every data value to be a string. Typed as such here rather
   * than serialised at the edge, so a caller passing a number fails to compile
   * instead of failing at delivery time.
   */
  data: Record<string, string>;
}

/**
 * What happened to one token.
 *
 * `invalid` is separate from `failed` because the two demand opposite
 * responses: an invalid token must be revoked so it is never selected again,
 * while a failure is transient and the token must be KEPT. Collapsing them
 * would eventually revoke every device during an FCM outage.
 */
export type PushOutcome =
  | { token: string; status: 'delivered' }
  | { token: string; status: 'invalid'; reason: string }
  | { token: string; status: 'failed'; reason: string };

export interface PushSender {
  /**
   * Deliver to each token independently.
   *
   * Never rejects: one bad token must not lose the others. Every token comes
   * back with an outcome.
   */
  send(messages: readonly PushMessage[]): Promise<PushOutcome[]>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/**
 * The sender used when push is not configured.
 *
 * It reports every token as `failed`, never `delivered` and never `invalid`.
 * That distinction matters: reporting success would make the metrics claim
 * notifications are working, and reporting `invalid` would revoke every real
 * device token in the database the first time someone deployed without
 * credentials.
 */
export class UnconfiguredPushSender implements PushSender {
  constructor(private readonly reason: string) {}

  send(messages: readonly PushMessage[]): Promise<PushOutcome[]> {
    return Promise.resolve(
      messages.map((message) => ({
        token: message.token,
        status: 'failed' as const,
        reason: this.reason,
      })),
    );
  }
}

/** Records what it was asked to send. Test double. */
export class InMemoryPushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  /** Tokens to report as permanently invalid. */
  readonly invalidTokens = new Set<string>();
  /** Tokens to report as a transient failure. */
  readonly failingTokens = new Set<string>();

  send(messages: readonly PushMessage[]): Promise<PushOutcome[]> {
    const outcomes: PushOutcome[] = [];

    for (const message of messages) {
      if (this.invalidTokens.has(message.token)) {
        outcomes.push({ token: message.token, status: 'invalid', reason: 'UNREGISTERED' });
        continue;
      }
      if (this.failingTokens.has(message.token)) {
        outcomes.push({ token: message.token, status: 'failed', reason: 'UNAVAILABLE' });
        continue;
      }
      this.sent.push(message);
      outcomes.push({ token: message.token, status: 'delivered' });
    }

    return Promise.resolve(outcomes);
  }
}
