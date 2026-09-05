import { useEffect, useState } from 'react';

import { sellSubscription, subscriptionPlans } from '../api';
import type { SubscriptionPlan } from '../data-provider';
import { formatIqd } from '../money';

/**
 * Selling a driver a subscription period, expanded inline under their row.
 *
 * ## Why this is the only way it happens
 *
 * v1 has no live payment rail: CLAUDE.md §2 keeps a gateway out of scope and
 * DECISIONS.md D-019 records why it stays out until there are drivers already
 * paying. So the operator takes cash in hand and records the period here. There
 * is no driver-facing purchase screen, and building one would be promising a
 * payment flow the system cannot perform.
 *
 * Without this screen the endpoint has no caller at all — the same failure D-018
 * describes for document verification, where a policy could be switched on with
 * no way for anyone to satisfy it. A subscription gate that nothing can satisfy
 * puts every driver in the city offline.
 *
 * ## The charge field
 *
 * Left blank charges the plan price. It is editable because an operator will
 * need to take a partial payment or grant a free period, and the alternative is
 * that they do it with a wallet top-up that is never tied to a subscription.
 *
 * Zero is a real, supported value: the server writes NO ledger rows for it (the
 * schema forbids a zero-amount entry and a single row could not balance), and
 * the period is stored with a null transaction id.
 */
export function Subscription({
  driverId,
  onGranted,
}: {
  driverId: string;
  onGranted: () => void;
}): JSX.Element {
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [planCode, setPlanCode] = useState('');
  const [charge, setCharge] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    subscriptionPlans()
      .then((result) => {
        if (cancelled) return;
        setPlans(result.plans);
        // Preselect the only plan there is. In v1 there is exactly one, and
        // making the operator pick it from a list of one is friction for
        // nothing.
        if (result.plans.length > 0) setPlanCode(result.plans[0]!.code);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'تعذر جلب الباقات');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const selected = plans?.find((plan) => plan.code === planCode) ?? null;

  async function submit(): Promise<void> {
    if (!planCode) return;

    // Parsed and validated here as well as at the server. CLAUDE.md §6.1 makes
    // money whole dinars, and a stray decimal typed into this box should be
    // refused before it becomes a request, not after.
    let chargeIqd: number | undefined;
    if (charge.trim() !== '') {
      const parsed = Number(charge.trim());
      if (!Number.isInteger(parsed) || parsed < 0) {
        setError('المبلغ يجب أن يكون عدداً صحيحاً بالدينار.');
        return;
      }
      chargeIqd = parsed;
    }

    setBusy(true);
    setError(null);
    try {
      const granted = await sellSubscription(driverId, {
        planCode,
        ...(chargeIqd !== undefined ? { chargeIqd } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setDone(granted.expiresAt);
      setCharge('');
      setNote('');
      // The driver row shows a wallet balance and the capability gate reads the
      // new period, so the list has to reload rather than keep a stale row.
      onGranted();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'تعذر تسجيل الاشتراك');
    } finally {
      setBusy(false);
    }
  }

  if (error !== null && plans === null) {
    return <p className="error">{error}</p>;
  }

  if (plans === null) return <p>جارٍ التحميل…</p>;

  if (plans.length === 0) {
    return (
      <p className="error">
        لا توجد باقات مفعّلة. أضف باقة قبل بيع أي اشتراك.
      </p>
    );
  }

  return (
    <div className="panel">
      <h4>بيع اشتراك</h4>

      <label>
        الباقة
        <select value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
          {plans.map((plan) => (
            <option key={plan.code} value={plan.code}>
              {plan.nameAr} — {formatIqd(plan.priceIqd)} / {plan.durationDays} يوم
            </option>
          ))}
        </select>
      </label>

      <label>
        المبلغ المستلم (اتركه فارغاً لسعر الباقة)
        <input
          type="number"
          inputMode="numeric"
          step={1}
          min={0}
          value={charge}
          placeholder={selected ? String(selected.priceIqd) : ''}
          onChange={(e) => setCharge(e.target.value)}
        />
      </label>

      <label>
        ملاحظة
        <input
          type="text"
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      <button onClick={() => void submit()} disabled={busy || !planCode}>
        {busy ? 'جارٍ التسجيل…' : 'تسجيل الاشتراك'}
      </button>

      {/* The expiry date, because it is the one fact the operator has to read
          back to the driver. */}
      {done !== null && (
        <p className="success">
          تم التسجيل. ينتهي في {new Date(done).toLocaleDateString('en-GB')}
        </p>
      )}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
