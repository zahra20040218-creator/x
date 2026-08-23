import { useLogin } from '@refinedev/core';
import type { ConfirmationResult } from 'firebase/auth';
import { useState } from 'react';

import { isFirebaseConfigured, missingFirebaseKeys, sendOtp } from '../firebase';

/**
 * Two steps: phone, then the code.
 *
 * If Firebase is not configured this screen says which variables are missing
 * rather than offering a login button that cannot work. An operator staring at
 * "فشل الطلب" has no way to discover that `VITE_FIREBASE_API_KEY` is empty.
 */
export function LoginPage(): JSX.Element {
  const { mutate: login, isLoading } = useLogin();

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const configured = isFirebaseConfigured();

  async function handleSendOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSending(true);
    try {
      setConfirmation(await sendOtp(phone, 'recaptcha-container'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function handleVerify(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!confirmation) return;

    try {
      const credential = await confirmation.confirm(code);
      const firebaseIdToken = await credential.user.getIdToken();
      login({ firebaseIdToken });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="login">
      <div className="card">
        <h1>لوحة الإدارة</h1>

        {!configured && (
          <div className="banner banner-error">
            <strong>لا يمكن تسجيل الدخول.</strong>
            <p>
              إعدادات Firebase ناقصة، والواجهة الخلفية لا تقبل إلا رمز Firebase —
              لا يوجد تسجيل دخول بكلمة مرور في هذا النظام.
            </p>
            <p>المتغيّرات الناقصة:</p>
            <ul>
              {missingFirebaseKeys().map((key) => (
                <li key={key}>
                  <code>{key}</code>
                </li>
              ))}
            </ul>
            <p>انظر <code>apps/admin/.env.example</code>.</p>
          </div>
        )}

        {error && <div className="banner banner-error">{error}</div>}

        {!confirmation ? (
          <form onSubmit={(e) => void handleSendOtp(e)}>
            <label htmlFor="phone">رقم الهاتف</label>
            <input
              id="phone"
              inputMode="tel"
              // A phone number reads left-to-right even inside an Arabic RTL
              // page. Without this the digits and the leading 0 render in an
              // order the operator has to mentally reverse.
              dir="ltr"
              placeholder="07XXXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={!configured || sending}
              required
            />
            <button type="submit" disabled={!configured || sending || phone.length < 10}>
              {sending ? 'جارٍ الإرسال…' : 'إرسال الرمز'}
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void handleVerify(e)}>
            <label htmlFor="code">رمز التحقق</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <button type="submit" disabled={isLoading || code.length < 4}>
              {isLoading ? 'جارٍ الدخول…' : 'دخول'}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setConfirmation(null);
                setCode('');
              }}
            >
              تغيير الرقم
            </button>
          </form>
        )}

        {/* Firebase attaches the invisible reCAPTCHA here. */}
        <div id="recaptcha-container" />
      </div>
    </div>
  );
}
