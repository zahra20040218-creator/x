import { useCallback, useEffect, useState } from 'react';

import { closeDispute, disputes } from '../api';
import type { Dispute } from '../data-provider';
import { formatDateTime } from '../money';

/**
 * Complaints from riders and drivers, and closing them.
 *
 * ## Why this page had to exist
 *
 * `POST /rides/{id}/dispute` has had a caller in both apps since 2026-08-24, so
 * riders and drivers have been able to open disputes — and there was no screen
 * anywhere that could read one. Every complaint went into a table nobody could
 * see. That is worse than not having the feature: the apps promise someone is
 * looking.
 *
 * ## OPEN first, and why the filter defaults there
 *
 * The operational question is "what still needs a decision", not "what has ever
 * been complained about". Defaulting to every status would bury the four open
 * disputes under a year of closed ones.
 *
 * ## A resolution note is mandatory
 *
 * The contract requires a non-empty `resolution`, and this enforces it before
 * the request rather than after the 422. A dispute closed with an empty note is
 * indistinguishable from one nobody read, and months later the note is the only
 * record of what was decided and why.
 */

const STATUS_AR: Record<Dispute['status'], string> = {
  OPEN: 'مفتوحة',
  RESOLVED: 'محلولة',
  REJECTED: 'مرفوضة',
};

const REASON_AR: Record<string, string> = {
  FARE_WRONG: 'الأجرة غير صحيحة',
  DRIVER_NO_SHOW: 'السائق لم يحضر',
  RIDER_NO_SHOW: 'الراكب لم يحضر',
  UNSAFE: 'سلوك غير آمن',
  OTHER: 'مشكلة أخرى',
};

export function DisputesPage(): JSX.Element {
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED' | 'REJECTED' | ''>('OPEN');
  const [items, setItems] = useState<Dispute[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await disputes(status === '' ? {} : { status });
      setItems(page.items);
      setCursor(page.nextCursor ?? null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'تعذر جلب الشكاوى');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Append the next page rather than replace it.
   *
   * Replacing is how a list silently stops at 25 rows: the operator sees a
   * plausible screen and no indication that anything is missing.
   */
  async function loadMore(): Promise<void> {
    if (cursor === null) return;
    try {
      const page = await disputes({
        ...(status === '' ? {} : { status }),
        cursor,
      });
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor ?? null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'تعذر جلب المزيد');
    }
  }

  return (
    <section>
      <h2>الشكاوى</h2>

      <label>
        الحالة
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="OPEN">مفتوحة</option>
          <option value="RESOLVED">محلولة</option>
          <option value="REJECTED">مرفوضة</option>
          <option value="">الكل</option>
        </select>
      </label>

      {error !== null && <p className="error">{error}</p>}
      {loading && <p>جارٍ التحميل…</p>}
      {!loading && items.length === 0 && <p>لا توجد شكاوى بهذه الحالة.</p>}

      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>الرحلة</th>
              <th>السبب</th>
              <th>الوصف</th>
              <th>الحالة</th>
              <th>فُتحت</th>
              <th>الإجراء</th>
            </tr>
          </thead>
          <tbody>
            {items.map((dispute) => (
              <DisputeRow key={dispute.id} dispute={dispute} onChanged={() => void load()} />
            ))}
          </tbody>
        </table>
      )}

      {cursor !== null && (
        <button onClick={() => void loadMore()}>تحميل المزيد</button>
      )}
    </section>
  );
}

function DisputeRow({
  dispute,
  onChanged,
}: {
  dispute: Dispute;
  onChanged: () => void;
}): JSX.Element {
  const [resolving, setResolving] = useState(false);

  return (
    <>
      <tr>
        {/* The ride id, shortened. Operators quote it to riders; the full UUID
            is unreadable over the phone. */}
        <td title={dispute.rideId}>{dispute.rideId.split('-')[0]?.toUpperCase()}</td>
        <td>{REASON_AR[dispute.reasonCode] ?? dispute.reasonCode}</td>
        <td>{dispute.description || '—'}</td>
        <td>
          <span className="tag">{STATUS_AR[dispute.status] ?? dispute.status}</span>
        </td>
        <td>{formatDateTime(dispute.createdAt)}</td>
        <td className="actions">
          {dispute.status === 'OPEN' ? (
            <button onClick={() => setResolving((v) => !v)}>حسم</button>
          ) : (
            // Closed disputes show the note instead of a button. The decision
            // is the useful artefact, not the fact that it was closed.
            <span title={dispute.resolution ?? ''}>{dispute.resolution ?? '—'}</span>
          )}
        </td>
      </tr>
      {resolving && (
        <tr>
          <td colSpan={6}>
            <Resolve
              dispute={dispute}
              onDone={() => {
                setResolving(false);
                onChanged();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function Resolve({
  dispute,
  onDone,
}: {
  dispute: Dispute;
  onDone: () => void;
}): JSX.Element {
  const [outcome, setOutcome] = useState<'RESOLVED' | 'REJECTED'>('RESOLVED');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    // Checked here as well as at the server. The contract sets minLength 1, and
    // catching it before the request gives the operator the message in Arabic
    // instead of an RFC 9457 validation body.
    if (resolution.trim() === '') {
      setError('اكتب سبب القرار. لا يمكن حسم شكوى بلا ملاحظة.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await closeDispute(dispute.id, { outcome, resolution: resolution.trim() });
      onDone();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'تعذر حسم الشكوى');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h4>حسم الشكوى</h4>

      <label>
        القرار
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as 'RESOLVED' | 'REJECTED')}
        >
          <option value="RESOLVED">محلولة</option>
          <option value="REJECTED">مرفوضة</option>
        </select>
      </label>

      <label>
        الملاحظة
        <textarea
          maxLength={2000}
          rows={3}
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
        />
      </label>

      <button onClick={() => void submit()} disabled={busy}>
        {busy ? 'جارٍ الحسم…' : 'حسم'}
      </button>

      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
