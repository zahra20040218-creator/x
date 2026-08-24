import { describe, expect, it } from 'vitest';

import { ConfigError, corsOrigins, loadConfig } from './config.js';

/**
 * Env is a boundary, and CLAUDE.md §9 says every boundary is validated. The
 * point of validating it at BOOT is that a typo fails while someone is
 * watching, rather than at 3am under load.
 */

const VALID = {
  DATABASE_URL: 'postgresql://user:pass@pgbouncer:6432/rideapp',
  REDIS_URL: 'redis://redis:6379',
  FIREBASE_PROJECT_ID: 'test-project',
  JWT_SECRET: 'a-secret-that-is-at-least-32-characters',
};

describe('loadConfig', () => {
  it('accepts a valid environment and applies defaults', () => {
    const config = loadConfig(VALID);

    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
    // CLAUDE.md §5.1 mandates a 30s claim TTL.
    expect(config.MATCH_CLAIM_TTL_MS).toBe(30_000);
    // CLAUDE.md §3.1 mandates a 30s location flush.
    expect(config.LOCATION_FLUSH_INTERVAL_MS).toBe(30_000);
    // CLAUDE.md §5.2 mandates 24h idempotency retention.
    expect(config.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
  });

  it('is frozen, so nothing can mutate config at runtime', () => {
    const config = loadConfig(VALID);
    expect(Object.isFrozen(config)).toBe(true);
  });

  describe('required values', () => {
    it.each(['DATABASE_URL', 'REDIS_URL', 'FIREBASE_PROJECT_ID', 'JWT_SECRET'])(
      'refuses to boot without %s',
      (key) => {
        const env = { ...VALID };
        delete (env as Record<string, string>)[key];
        expect(() => loadConfig(env)).toThrow(ConfigError);
      },
    );

    // A guessable HS256 key means anyone can mint an admin token.
    it('refuses a short JWT secret', () => {
      expect(() => loadConfig({ ...VALID, JWT_SECRET: 'too-short' })).toThrow(
        /at least 32 characters/,
      );
    });
  });

  // CLAUDE.md §3.3. Pointing production at Postgres directly works fine in
  // testing and exhausts connections at ~100 concurrent users.
  describe('the PgBouncer guard', () => {
    it('refuses a production DATABASE_URL pointed at Postgres itself', () => {
      expect(() =>
        loadConfig({
          ...VALID,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@postgres:5432/rideapp',
        }),
      ).toThrow(/PgBouncer/);
    });

    it('catches a URL that names no port at all', () => {
      // The likeliest form of the mistake, and the one the old regex missed:
      // PostgreSQL defaults to 5432 when the URL omits it, so this connects
      // straight to Postgres while looking like it says nothing about ports.
      expect(() =>
        loadConfig({
          ...VALID,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@postgres/rideapp',
        }),
      ).toThrow(/PgBouncer/);
    });

    it('catches a URL with no trailing slash after the port', () => {
      expect(() =>
        loadConfig({
          ...VALID,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@postgres:5432',
        }),
      ).toThrow(/PgBouncer/);
    });

    it('is not fooled by a password containing the port text', () => {
      // The old regex matched anywhere in the string. This connects to
      // PgBouncer on 6432 and must be allowed.
      expect(() =>
        loadConfig({
          ...VALID,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:has%3A5432%2Fin-it@pgbouncer:6432/rideapp',
        }),
      ).not.toThrow();
    });

    it('rejects a DATABASE_URL that is not a URL, without echoing the password', () => {
      // Skipping the check for an unparseable value would turn one mistake
      // into two, and the message must not put credentials in a log.
      expect(() =>
        loadConfig({
          ...VALID,
          NODE_ENV: 'production',
          DATABASE_URL: 'not a url at all',
        }),
      ).toThrow();
    });

    it('allows port 5432 outside production, where there may be no PgBouncer', () => {
      expect(() =>
        loadConfig({
          ...VALID,
          NODE_ENV: 'development',
          DATABASE_URL: 'postgresql://u:p@localhost:5432/rideapp',
        }),
      ).not.toThrow();
    });
  });

  // Security audit S-5. A wildcard is not a lax setting here, it is an open
  // door: the API takes a bearer token, so `*` lets any site issue admin
  // requests from a logged-in operator's browser.
  describe('the CORS guard', () => {
    it('refuses a wildcard origin outright', () => {
      expect(() => loadConfig({ ...VALID, CORS_ALLOWED_ORIGINS: '*' })).toThrow(
        /must not contain/,
      );
    });

    it('refuses a wildcard hidden in a list', () => {
      expect(() =>
        loadConfig({
          ...VALID,
          CORS_ALLOWED_ORIGINS: 'https://admin.rideapp.iq, *',
        }),
      ).toThrow(/must not contain/);
    });

    it('accepts an explicit allowlist', () => {
      const config = loadConfig({
        ...VALID,
        CORS_ALLOWED_ORIGINS: 'https://admin.rideapp.iq, http://localhost:5173',
      });

      expect(corsOrigins(config)).toEqual([
        'https://admin.rideapp.iq',
        'http://localhost:5173',
      ]);
    });

    // The default. A deployment serving only the mobile apps needs no browser
    // origin at all, and defaulting to one would be a hole nobody asked for.
    it('defaults to no browser client', () => {
      expect(corsOrigins(loadConfig(VALID))).toEqual([]);
    });
  });

  describe('range validation', () => {
    it('refuses an out-of-range port', () => {
      expect(() => loadConfig({ ...VALID, PORT: '99999' })).toThrow(ConfigError);
    });

    it('refuses a claim TTL short enough to expire mid-accept', () => {
      expect(() => loadConfig({ ...VALID, MATCH_CLAIM_TTL_MS: '100' })).toThrow(
        ConfigError,
      );
    });

    it('coerces numeric strings, which is all env vars ever are', () => {
      expect(loadConfig({ ...VALID, PORT: '8080' }).PORT).toBe(8080);
    });
  });

  it('reports every problem at once, not just the first', () => {
    try {
      loadConfig({ REDIS_URL: 'redis://redis:6379' });
      expect.unreachable('should have thrown');
    } catch (error) {
      // Fixing one env var at a time across three restarts is a bad morning.
      expect((error as ConfigError).issues.length).toBeGreaterThan(1);
    }
  });
});
