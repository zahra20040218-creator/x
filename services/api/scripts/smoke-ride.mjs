/**
 * One complete ride, over HTTP, against real PostgreSQL + PostGIS + Redis.
 *
 * The unit and e2e suites run against fakes; the integration suite exercises
 * the schema. Nothing exercised the whole SYSTEM - API process, worker process,
 * real database, real Redis - in the shape it actually ships. This does.
 *
 * ## Why it mints its own tokens
 *
 * Sign-in verifies a Google ID token against Firebase's JWKS, which needs a
 * real Firebase project. Everything AFTER that step is ours: the session token
 * is signed with `JWT_SECRET`, which this process has. So the entire
 * authenticated surface is reachable without a Firebase account - and without
 * an Android phone.
 *
 * The `sid` claim names a real row in `refresh_tokens`, inserted here, because
 * `loadUser` checks the session is live on every request. Faking that claim
 * would test a weaker system than the one that ships.
 *
 * ## What it cannot prove
 *
 * Anything requiring a handset: background location surviving Doze, vendor
 * process killing, GPS while moving, Wi-Fi to mobile handover. Those are
 * CLAUDE.md §5.3 and they need a phone - see docs/DEVICE_TEST_PLAN.md.
 *
 * ## Running it
 *
 *   wsl -d Ubuntu -u root -- bash scripts/wsl-infra.sh   # see docs/LOCAL_INFRA_WSL.md
 *   node dist/db/migrate.js up && node dist/db/seed.js
 *   node dist/main.js &   node dist/worker.js &          # BOTH - see step 5
 *   node scripts/smoke-ride.mjs
 */
import { SignJWT } from 'jose';
import pg from 'pg';

const SECRET = new TextEncoder().encode('local-development-secret-not-for-any-real-deployment');
const API = 'http://localhost:3000/v1';
const db = new pg.Client({ connectionString: 'postgres://rideapp:rideapp@localhost:5432/rideapp' });
await db.connect();

const users = await db.query(`SELECT id, role, display_name FROM users ORDER BY role, display_name`);
const rider  = users.rows.find(u => u.role === 'RIDER');
const driver = users.rows.filter(u => u.role === 'DRIVER')[0];

// Minted directly rather than through Firebase: sign-in verifies a Google ID
// token against JWKS, which needs a real Firebase project. The session token
// AFTER that step is ours, and its secret is in this process's env - so the
// whole authenticated surface is reachable without one.
// The `sid` claim must name a LIVE row in refresh_tokens - `loadUser` checks
// it on every request, which is what makes logout and targeted revocation
// work at all. So a session is inserted here rather than faked in the token.
const openSession = async (u) => {
  const r = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour') RETURNING session_id`,
    [u.id, 'smoke-' + crypto.randomUUID()],
  );
  return r.rows[0].session_id;
};

const mint = async (u) => new SignJWT({ role: u.role, sid: await openSession(u) })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(u.id).setIssuer('rideapp').setAudience('rideapp-clients')
  .setIssuedAt().setExpirationTime('1h').sign(SECRET);

const riderTok = await mint(rider);
const driverTok = await mint(driver);

const call = async (method, path, { token, body, key } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

const step = (n, label, ok, detail = '') =>
  console.log(`${ok ? '  OK ' : 'FAIL'}  ${n}. ${label}${detail ? '  — ' + detail : ''}`);

const TAHRIR  = { lat: 33.3061, lng: 44.4213 };
const KARRADA = { lat: 33.2989, lng: 44.4361 };
const uuid = () => crypto.randomUUID();

console.log('\n=== a complete ride, over HTTP, against real Postgres + Redis ===\n');

let r = await call('GET', '/me', { token: riderTok });
step(1, 'rider identifies', r.status === 200, r.json?.displayName);

r = await call('PUT', '/driver/availability', {
  token: driverTok, body: { availability: 'ONLINE', position: KARRADA },
});
step(2, 'driver goes ONLINE', r.status === 200, `capability gate passed`);

const idem = uuid();
r = await call('POST', '/rides', {
  token: riderTok, key: idem,
  body: { pickup: TAHRIR, dropoff: KARRADA },
});
const rideId = r.json?.id;
step(3, 'rider requests a ride', r.status === 201, `fare ${r.json?.estimatedFareIqd} IQD`);

// §5.2 - the same key must return the ORIGINAL ride, not a second one.
const again = await call('POST', '/rides', {
  token: riderTok, key: idem,
  body: { pickup: TAHRIR, dropoff: KARRADA },
});
step(4, 'idempotent retry returns the SAME ride',
  again.status === 200 && again.json?.id === rideId, `200 not 201`);

// Dispatch is the worker's job. This is the part that silently does nothing
// when the worker is not running.
await new Promise(r => setTimeout(r, 3000));
const offered = await db.query(
  `SELECT status FROM rides WHERE id = $1`, [rideId]);
step(5, 'the WORKER dispatched it', offered.rows[0]?.status === 'OFFERED',
  `status=${offered.rows[0]?.status}`);

r = await call('POST', `/rides/${rideId}/accept`, { token: driverTok });
step(6, 'driver accepts (atomic Redis claim)', r.status === 200, r.json?.status);

r = await call('POST', `/rides/${rideId}/arrived`, { token: driverTok });
step(7, 'driver arrives', r.status === 200, r.json?.status);

r = await call('POST', `/rides/${rideId}/start`, { token: driverTok });
step(8, 'trip starts', r.status === 200, r.json?.status);

r = await call('POST', `/rides/${rideId}/complete`, {
  token: driverTok, body: { actualDistanceM: 5200 },
});
const settled = await db.query(
  `SELECT estimated_fare_iqd e, final_fare_iqd f FROM rides WHERE id = $1`, [rideId]);
const { e, f } = settled.rows[0];
// D-004: settlement recomputes from the odometer and takes the HIGHER of that
// and the quote. Charging less than the quote on a short trip would make every
// quote a maximum rather than a price.
step(9, 'trip completes and settles', r.status === 200 && Number(f) >= Number(e),
  `quoted ${e} -> settled ${f} IQD on 5200m`);

// §6.2 - every financial event writes >= 2 rows summing to zero.
const led = await db.query(
  `SELECT account_type, direction, amount_iqd FROM ledger_entries WHERE ride_id = $1`, [rideId]);
const net = led.rows.reduce((s, e) =>
  s + (e.direction === 'CREDIT' ? +e.amount_iqd : -e.amount_iqd), 0);
step(10, 'ledger balances to zero', led.rows.length >= 2 && net === 0,
  `${led.rows.length} entries, net ${net}`);
console.log('       ' + led.rows.map(e => `${e.direction} ${e.account_type} ${e.amount_iqd}`).join('\n       '));

const pay = await db.query(`SELECT provider, status, amount_iqd FROM payments WHERE ride_id = $1`, [rideId]);
step(11, 'payment recorded through the §7 seam',
  pay.rows[0]?.status === 'CONFIRMED', `${pay.rows[0]?.provider} ${pay.rows[0]?.amount_iqd}`);

const ev = await db.query(`SELECT count(*)::int n FROM ride_events WHERE ride_id = $1`, [rideId]);
step(12, 'every transition wrote an audit row', ev.rows[0].n >= 5, `${ev.rows[0].n} events`);

await db.end();
console.log('');
