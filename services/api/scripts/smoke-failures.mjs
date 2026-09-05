/**
 * The three failure paths CLAUDE.md §10 requires, against the real system.
 *
 *   "E2E | One happy path + three failure paths (network drop mid-ride,
 *    driver declines, no drivers available)"
 *
 * `smoke-ride.mjs` covers the happy path. These are the other three, and they
 * matter more: a ride-hailing product fails in its sad paths, not its happy
 * one. Every check runs against the API process, the worker process, real
 * PostgreSQL/PostGIS and real Redis — the shape that ships.
 *
 * A fourth scenario is included that §10 does not list: two drivers racing for
 * one ride. It is the guarantee §5.1 exists for, and it cannot be observed
 * without two processes and a real Redis.
 *
 *   node scripts/smoke-failures.mjs
 */
import { SignJWT } from 'jose';
import pg from 'pg';

const SECRET = new TextEncoder().encode('local-development-secret-not-for-any-real-deployment');
const API = 'http://localhost:3000/v1';
const db = new pg.Client({ connectionString: 'postgres://rideapp:rideapp@localhost:5432/rideapp' });
await db.connect();

const users = await db.query(`SELECT id, role, display_name FROM users ORDER BY role, display_name`);
const rider = users.rows.find((u) => u.role === 'RIDER');
const drivers = users.rows.filter((u) => u.role === 'DRIVER');

const openSession = async (u) =>
  (
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour') RETURNING session_id`,
      [u.id, 'smoke-' + crypto.randomUUID()],
    )
  ).rows[0].session_id;

const mint = async (u) =>
  new SignJWT({ role: u.role, sid: await openSession(u) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(u.id)
    .setIssuer('rideapp')
    .setAudience('rideapp-clients')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(SECRET);

const riderTok = await mint(rider);
const dTok = [await mint(drivers[0]), await mint(drivers[1])];

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
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
};

let failed = 0;
const step = (n, label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  OK ' : 'FAIL'}  ${n}. ${label}${detail ? '  — ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAHRIR = { lat: 33.3061, lng: 44.4213 };
const KARRADA = { lat: 33.2989, lng: 44.4361 };

const offline = (t) =>
  call('PUT', '/driver/availability', { token: t, body: { availability: 'OFFLINE' } });
const online = (t) =>
  call('PUT', '/driver/availability', {
    token: t,
    body: { availability: 'ONLINE', position: KARRADA },
  });
const cancel = (id) =>
  call('POST', `/rides/${id}/cancel`, { token: riderTok, body: { reason: 'smoke test' } });

console.log('\n=== §10 failure paths, against the real system ===\n');

// ---------------------------------------------------------------------------
console.log('--- 1. a dropped request, retried (§5.2) ---');
// Baghdad mobile networks drop requests mid-flight. Without idempotency a rider
// who loses signal creates three rides and three drivers get dispatched.
await offline(dTok[0]);
await offline(dTok[1]);
await online(dTok[0]);

const key = crypto.randomUUID();
const body = { pickup: TAHRIR, dropoff: KARRADA };

// Counted BEFORE, and compared as a delta. Counting "rides in the last two
// minutes" instead made this fail on the second run of the script against the
// same database - which is a broken assertion, not a broken system, and
// exactly the kind of flake that teaches people to ignore a red check.
const beforeCount = (
  await db.query(`SELECT count(*)::int n FROM rides WHERE rider_id = $1`, [rider.id])
).rows[0].n;

const first = await call('POST', '/rides', { token: riderTok, key, body });

const retries = [];
for (let i = 0; i < 4; i += 1) {
  retries.push(await call('POST', '/rides', { token: riderTok, key, body }));
}

step(
  1,
  'five identical requests create ONE ride',
  first.status === 201 && retries.every((r) => r.status === 200 && r.json?.id === first.json.id),
  `201 then 4x200`,
);

const afterCount = (
  await db.query(`SELECT count(*)::int n FROM rides WHERE rider_id = $1`, [rider.id])
).rows[0].n;
const delta = afterCount - beforeCount;
step(2, 'the database gained ONE ride, not five', delta === 1, `+${delta} row(s)`);

// The same key with a DIFFERENT body is a client bug, not a retry, and
// answering 200 with the old ride would hide it.
const conflict = await call('POST', '/rides', {
  token: riderTok,
  key,
  body: { pickup: KARRADA, dropoff: TAHRIR },
});
step(3, 'the same key with a different body is REFUSED', conflict.status === 409, `${conflict.status}`);

await cancel(first.json.id);

// ---------------------------------------------------------------------------
console.log('\n--- 2. the driver declines ---');
await offline(dTok[1]);
await online(dTok[0]);

const r2 = await call('POST', '/rides', { token: riderTok, key: crypto.randomUUID(), body });
await sleep(3000);

let st = await db.query(`SELECT status FROM rides WHERE id = $1`, [r2.json.id]);
step(4, 'the worker offered it to a driver', st.rows[0].status === 'OFFERED', st.rows[0].status);

const declined = await call('POST', `/rides/${r2.json.id}/decline`, { token: dTok[0] });
step(5, 'the driver declines', declined.status === 204, `${declined.status}`);

// A decline must return the ride to the pool. There is a rider standing on a
// kerb; the ride must not die because one driver said no.
await sleep(2500);
st = await db.query(`SELECT status FROM rides WHERE id = $1`, [r2.json.id]);
step(
  6,
  'the ride returns to the pool, not to a dead end',
  ['REQUESTED', 'OFFERED', 'NO_DRIVERS_FOUND'].includes(st.rows[0].status),
  st.rows[0].status,
);

const offers = await db.query(
  `SELECT status FROM ride_offers WHERE ride_id = $1 ORDER BY offered_at`,
  [r2.json.id],
);
step(
  7,
  'the declined offer is recorded, not deleted',
  offers.rows.some((o) => o.status === 'DECLINED'),
  offers.rows.map((o) => o.status).join(','),
);

await cancel(r2.json.id);

// ---------------------------------------------------------------------------
console.log('\n--- 3. nobody is online ---');
await offline(dTok[0]);
await offline(dTok[1]);
await sleep(1000);

const r3 = await call('POST', '/rides', { token: riderTok, key: crypto.randomUUID(), body });
step(8, 'the request still succeeds', r3.status === 201, `${r3.status}`);

await sleep(4000);
st = await db.query(`SELECT status FROM rides WHERE id = $1`, [r3.json.id]);
step(
  9,
  'it ends in NO_DRIVERS_FOUND, not stuck at REQUESTED',
  st.rows[0].status === 'NO_DRIVERS_FOUND',
  st.rows[0].status,
);

// A ride that sits silently at REQUESTED forever is the worst outcome: the app
// shows a spinner and nothing ever happens.
const events = await db.query(
  `SELECT to_state FROM ride_events WHERE ride_id = $1 ORDER BY created_at`,
  [r3.json.id],
);
step(
  10,
  'the transition reached the audit trail',
  events.rows.some((e) => e.to_state === 'NO_DRIVERS_FOUND'),
  events.rows.map((e) => e.to_state).join(' -> '),
);

// ---------------------------------------------------------------------------
console.log('\n--- 4. two drivers race for one ride (§5.1) ---');
await online(dTok[0]);
await online(dTok[1]);

const r4 = await call('POST', '/rides', { token: riderTok, key: crypto.randomUUID(), body });
await sleep(3000);

// Fired together on purpose: "two drivers must never accept the same ride".
//
// Note what the loser actually gets, because it is easy to misread. §5.1 says
// the losing CLAIMANT gets 409, and that is what `claimOrThrow` throws. But
// dispatch offers a ride to one driver at a time, so the second driver here
// usually never held an offer at all and is refused with 404 before the claim
// is contested — the same rule that stops a rider learning another rider's
// ride exists.
//
// Both refusals are correct and they are different. What this asserts is the
// invariant covering both: exactly one 200. The claim-contention path itself —
// two drivers BOTH holding a pending offer — is covered in
// test/integration/real-reconnect-duplicate.test.ts.
const race = await Promise.all([
  call('POST', `/rides/${r4.json.id}/accept`, { token: dTok[0] }),
  call('POST', `/rides/${r4.json.id}/accept`, { token: dTok[1] }),
]);

step(
  11,
  'exactly ONE driver wins the race',
  race.filter((r) => r.status === 200).length === 1,
  race.map((r) => r.status).join(' / '),
);

const assigned = await db.query(`SELECT driver_id FROM rides WHERE id = $1`, [r4.json.id]);
step(
  12,
  'the database assigned exactly one driver',
  assigned.rows[0].driver_id !== null,
  assigned.rows[0].driver_id?.slice(0, 8),
);

await cancel(r4.json.id);
await offline(dTok[0]);
await offline(dTok[1]);
await db.end();

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}\n`);
process.exit(failed === 0 ? 0 : 1);
