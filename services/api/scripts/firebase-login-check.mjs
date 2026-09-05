/**
 * Does a real Firebase ID token get a session out of our API?
 *
 * Not a mock. This mints a genuine ID token from the live Firebase project and
 * posts it to `/auth/otp/verify`, which verifies it against Google's public
 * JWKS exactly as it would for a token produced by the app on a handset.
 *
 * The app's own sign-in path (`verifyPhoneNumber` → SMS → `signInWithCredential`)
 * needs a device, SafetyNet/Play Integrity and a real SMS. What that path
 * ultimately produces is an ID token carrying a `phone_number` claim, and this
 * produces the same thing by a different route:
 *
 *   service account  →  OAuth2 access token
 *                    →  create/refresh a phone user (Identity Toolkit admin)
 *                    →  custom token
 *                    →  exchange for an ID token
 *                    →  POST /auth/otp/verify
 *
 * So it proves everything server-side and everything about the project's
 * configuration. It does NOT prove the on-device SMS flow - only a handset can.
 *
 *   FCM_SERVICE_ACCOUNT_PATH=~/keystores/fcm-service-account.json \
 *   WEB_API_KEY=<from google-services.json> \
 *   node scripts/firebase-login-check.mjs
 */

import { readFileSync } from 'node:fs';
import { SignJWT, importPKCS8 } from 'jose';

const SA_PATH = process.env['FCM_SERVICE_ACCOUNT_PATH'];
const API_KEY = process.env['WEB_API_KEY'];
const BASE = process.env['API_BASE'] ?? 'http://127.0.0.1:3000/v1';
const PHONE = process.env['TEST_PHONE'] ?? '+9647700000001';

if (!SA_PATH || !API_KEY) {
  process.stderr.write('FCM_SERVICE_ACCOUNT_PATH and WEB_API_KEY are required.\n');
  process.exit(2);
}

// Read, never print. The private key stays in memory.
const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
const key = await importPKCS8(sa.private_key, 'RS256');

const step = (n, t) => console.log(`\n[${n}] ${t}`);

// -- 1. Service account -> OAuth2 access token -------------------------------
step(1, 'Exchanging the service account for an access token');
const assertion = await new SignJWT({
  scope: 'https://www.googleapis.com/auth/identitytoolkit',
})
  .setProtectedHeader({ alg: 'RS256' })
  .setIssuer(sa.client_email)
  .setAudience('https://oauth2.googleapis.com/token')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(key);

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }),
});
const tokenBody = await tokenResponse.json();
if (!tokenBody.access_token) {
  console.log('    FAILED:', JSON.stringify(tokenBody).slice(0, 200));
  process.exit(1);
}
console.log(`    HTTP ${tokenResponse.status}  access token acquired`);

const admin = (path, body) =>
  fetch(`https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

// -- 2. A user with that phone number ----------------------------------------
step(2, `Ensuring a Firebase user exists for ${PHONE}`);
let created = await admin('/accounts', { phoneNumber: PHONE });
let uid = created.body?.localId;

if (!uid) {
  // Already exists - look it up instead.
  const lookup = await admin('/accounts:lookup', { phoneNumber: [PHONE] });
  uid = lookup.body?.users?.[0]?.localId;
}
if (!uid) {
  console.log('    FAILED:', JSON.stringify(created.body).slice(0, 250));
  process.exit(1);
}
console.log(`    uid ${uid}`);

// -- 3. Custom token -> ID token ---------------------------------------------
step(3, 'Minting a custom token and exchanging it for an ID token');
const customToken = await new SignJWT({ uid })
  .setProtectedHeader({ alg: 'RS256' })
  .setIssuer(sa.client_email)
  .setSubject(sa.client_email)
  .setAudience(
    'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
  )
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(key);

const exchange = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  },
);
const exchanged = await exchange.json();
if (!exchanged.idToken) {
  console.log('    FAILED:', JSON.stringify(exchanged).slice(0, 250));
  process.exit(1);
}

// The claims our verifier actually reads. Printed as a shape, not a value.
const claims = JSON.parse(Buffer.from(exchanged.idToken.split('.')[1], 'base64').toString());
console.log(`    HTTP ${exchange.status}`);
console.log(`    iss          ${claims.iss}`);
console.log(`    aud          ${claims.aud}`);
console.log(`    phone_number ${claims.phone_number ?? '<<MISSING>>'}`);

// -- 4. The real test --------------------------------------------------------
step(4, 'Posting that token to our own /auth/otp/verify');
const verify = await fetch(`${BASE}/auth/otp/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    firebaseIdToken: exchanged.idToken,
    role: 'RIDER',
    displayName: 'راكب اختبار',
  }),
});
const session = await verify.json();

console.log(`    HTTP ${verify.status}`);
const ok = verify.status === 200 && typeof session.accessToken === 'string';
if (ok) {
  console.log(`    access token issued (${session.accessToken.length} chars)`);
  console.log(`    refresh token issued: ${Boolean(session.refreshToken)}`);
} else {
  console.log('    body:', JSON.stringify(session).slice(0, 300));
}

const claimsOk = claims.iss === `https://securetoken.google.com/${sa.project_id}`
  && claims.aud === sa.project_id
  && typeof claims.phone_number === 'string';

console.log(`\n    ${ok && claimsOk ? 'LOGIN PATH PASS' : 'LOGIN PATH FAIL'}`);
process.exit(ok && claimsOk ? 0 : 1);
