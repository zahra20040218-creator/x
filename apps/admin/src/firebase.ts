import { type FirebaseApp, initializeApp } from 'firebase/app';
import {
  RecaptchaVerifier,
  type ConfirmationResult,
  getAuth,
  signInWithPhoneNumber,
} from 'firebase/auth';

/**
 * Firebase phone auth for the admin panel.
 *
 * The API accepts a Firebase ID token and nothing else, so this is not
 * optional infrastructure — without it the panel has no way to authenticate
 * anyone. `isFirebaseConfigured()` exists so the login screen can say exactly
 * that, instead of throwing an SDK error an operator cannot act on.
 *
 * None of these values are secrets: every Firebase web client ships them.
 * The security boundary is the Firebase project's authorised-domains list and
 * the server-side token verification, not the confidentiality of the API key.
 */

interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

function readConfig(): FirebaseConfig | null {
  const env = import.meta.env;
  const config = {
    apiKey: env['VITE_FIREBASE_API_KEY'],
    authDomain: env['VITE_FIREBASE_AUTH_DOMAIN'],
    projectId: env['VITE_FIREBASE_PROJECT_ID'],
    appId: env['VITE_FIREBASE_APP_ID'],
  };

  const missing = Object.entries(config)
    .filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([key]) => key);

  return missing.length === 0 ? (config as FirebaseConfig) : null;
}

export function isFirebaseConfigured(): boolean {
  return readConfig() !== null;
}

export function missingFirebaseKeys(): string[] {
  const env = import.meta.env;
  return (
    [
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_APP_ID',
    ] as const
  ).filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.length === 0;
  });
}

let app: FirebaseApp | null = null;

function ensureApp(): FirebaseApp {
  const config = readConfig();
  if (!config) {
    throw new Error(
      `إعدادات Firebase ناقصة: ${missingFirebaseKeys().join('، ')}`,
    );
  }
  app ??= initializeApp(config);
  return app;
}

/**
 * Send an OTP.
 *
 * `+964` is prefixed for a local `07…` number. The API normalises server-side
 * too (CLAUDE.md §8), but Firebase needs E.164 before it will send anything,
 * so the same rule has to exist on this side of the call.
 */
export async function sendOtp(
  phone: string,
  containerId: string,
): Promise<ConfirmationResult> {
  const auth = getAuth(ensureApp());
  auth.languageCode = 'ar';

  const normalised = phone.trim().startsWith('0')
    ? `+964${phone.trim().slice(1)}`
    : phone.trim();

  // reCAPTCHA is required by Firebase for phone auth on the web. Invisible so
  // it does not interrupt an operator who signs in several times a day.
  const verifier = new RecaptchaVerifier(auth, containerId, { size: 'invisible' });

  return signInWithPhoneNumber(auth, normalised, verifier);
}
