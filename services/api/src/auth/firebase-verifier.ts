import { createRemoteJWKSet, jwtVerify } from 'jose';

import { UnauthorizedProblem } from '../common/problem.js';

/**
 * Firebase Phone Auth ID token verification.
 *
 * CLAUDE.md §2 puts OTP in scope via Firebase. The server never sends or checks
 * an OTP code - the device does that with Firebase and hands us a signed ID
 * token. All this does is prove the token is genuinely Google's and pull out
 * the phone number.
 *
 * A port with a deterministic fake, because otherwise every auth test would
 * need a live Firebase project and a real handset.
 */

export interface FirebaseIdentity {
  uid: string;
  phoneNumber: string;
}

export interface FirebaseVerifier {
  verify(idToken: string): Promise<FirebaseIdentity>;
}

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/**
 * Real verifier: RS256 against Google's published JWKS.
 *
 * `createRemoteJWKSet` caches the key set and refetches only on rotation, so
 * this is not an outbound HTTP call per request - which would be a CLAUDE.md
 * §3.2 violation on the request path.
 */
export class GoogleFirebaseVerifier implements FirebaseVerifier {
  private readonly jwks = createRemoteJWKSet(new URL(JWKS_URL));

  constructor(private readonly projectId: string) {}

  async verify(idToken: string): Promise<FirebaseIdentity> {
    try {
      const { payload } = await jwtVerify(idToken, this.jwks, {
        issuer: `https://securetoken.google.com/${this.projectId}`,
        audience: this.projectId,
      });

      const uid = payload.sub;
      const phoneNumber = payload['phone_number'];

      if (typeof uid !== 'string' || typeof phoneNumber !== 'string') {
        // A token with no phone number is not a Phone Auth token - it may be an
        // anonymous or email sign-in, neither of which this platform uses.
        throw new UnauthorizedProblem('Firebase token carries no phone number.');
      }

      return { uid, phoneNumber };
    } catch (error) {
      if (error instanceof UnauthorizedProblem) throw error;
      throw new UnauthorizedProblem('Firebase ID token could not be verified.');
    }
  }
}

/** Deterministic fake for tests. Never registered outside a test container. */
export class FakeFirebaseVerifier implements FirebaseVerifier {
  private readonly tokens = new Map<string, FirebaseIdentity>();

  register(idToken: string, identity: FirebaseIdentity): void {
    this.tokens.set(idToken, identity);
  }

  // Not `async`: the body has nothing to await, and marking it async purely to
  // satisfy the interface is what require-await exists to flag. Identical
  // behaviour for every caller.
  verify(idToken: string): Promise<FirebaseIdentity> {
    const identity = this.tokens.get(idToken);
    return identity
      ? Promise.resolve(identity)
      : Promise.reject(new UnauthorizedProblem('Firebase ID token could not be verified.'));
  }
}

export const FIREBASE_VERIFIER = Symbol('FIREBASE_VERIFIER');
