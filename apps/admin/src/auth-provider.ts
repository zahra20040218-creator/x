import type { AuthProvider } from '@refinedev/core';

import type { AdminSession } from './data-provider';

/**
 * Admin authentication.
 *
 * There is no password login anywhere in this platform: the API accepts a
 * Firebase ID token and nothing else (`POST /v1/auth/otp/verify`). So the admin
 * panel signs in with the same phone-OTP flow as the mobile apps, and the
 * Firebase web config is a hard requirement — without it, nobody can log in
 * at all. `login.tsx` says so explicitly rather than failing obscurely.
 *
 * ## Where the tokens live
 *
 * The access token is held in memory only. The refresh token goes to
 * `localStorage`, which is a deliberate trade rather than an oversight:
 *
 *   - Keeping the access token out of storage means an XSS payload cannot read
 *     it from disk; it would have to run inside the live page.
 *   - The refresh token has to survive a page reload or every refresh logs the
 *     operator out. `httpOnly` cookies would be better, but the API is
 *     token-authenticated by design and adding cookie auth would introduce
 *     CSRF to a system that currently has none (security audit S-8).
 *
 * The mitigation that makes this acceptable is server-side: refresh tokens
 * ROTATE and are revocable, and `POST /v1/auth/logout` now kills the access
 * token immediately rather than leaving it valid for an hour (migration 0006).
 */

const REFRESH_KEY = 'rideapp.admin.refresh';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  user?: { role?: string };
}

export function createAuthProvider(
  baseUrl: string,
  session: AdminSession,
): AuthProvider & { restore: () => Promise<boolean> } {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as {
        detail?: string;
        title?: string;
      } | null;
      throw new Error(problem?.detail ?? problem?.title ?? `فشل الطلب (${response.status})`);
    }

    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  function store(pair: TokenPair): void {
    session.accessToken = pair.accessToken;
    localStorage.setItem(REFRESH_KEY, pair.refreshToken);
  }

  function clear(): void {
    session.accessToken = null;
    localStorage.removeItem(REFRESH_KEY);
  }

  /** Exchange a stored refresh token for a live session after a page reload. */
  async function restore(): Promise<boolean> {
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!refreshToken) return false;

    try {
      store(await post<TokenPair>('/auth/refresh', { refreshToken }));
      return true;
    } catch {
      // Rotation means a refresh token is single-use. A failure here is the
      // normal end of a session, not an error worth showing.
      clear();
      return false;
    }
  }

  return {
    restore,

    /**
     * @param params.firebaseIdToken obtained by `login.tsx` from Firebase.
     */
    login: async ({ firebaseIdToken }: { firebaseIdToken?: string }) => {
      if (!firebaseIdToken) {
        return { success: false, error: { name: 'login', message: 'رمز الدخول مفقود.' } };
      }

      try {
        const pair = await post<TokenPair>('/auth/otp/verify', {
          firebaseIdToken,
          role: 'ADMIN',
        });

        // Checked here as well as server-side. The API is authoritative — every
        // admin route is gated on @Roles('ADMIN') — but signing a non-admin
        // into this panel would hand them a UI full of buttons that all return
        // 403, which reads as "the panel is broken" rather than "you are not
        // an administrator".
        if (pair.user?.role !== 'ADMIN') {
          clear();
          return {
            success: false,
            error: { name: 'login', message: 'هذا الحساب ليس حساب إدارة.' },
          };
        }

        store(pair);
        return { success: true, redirectTo: '/' };
      } catch (error) {
        return {
          success: false,
          error: { name: 'login', message: (error as Error).message },
        };
      }
    },

    logout: async () => {
      // Best effort: the server-side revocation is what matters, but a network
      // failure must not strand the operator in a page they cannot leave.
      await post('/auth/logout', {}).catch(() => undefined);
      clear();
      return { success: true, redirectTo: '/login' };
    },

    check: async () => {
      if (session.accessToken) return { authenticated: true };
      if (await restore()) return { authenticated: true };
      return { authenticated: false, redirectTo: '/login' };
    },

    getIdentity: async () => {
      if (!session.accessToken) return null;
      try {
        const response = await fetch(`${baseUrl}/me`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        if (!response.ok) return null;
        return (await response.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    },

    onError: async (error) => {
      // A 401 mid-session means the token expired or the session was revoked
      // (an admin suspended, or someone logged out everywhere). Try one
      // refresh; if that fails the session is genuinely over.
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 401) {
        if (await restore()) return {};
        clear();
        return { logout: true, redirectTo: '/login' };
      }
      return {};
    },
  };
}
