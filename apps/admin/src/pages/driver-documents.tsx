import { useEffect, useState } from 'react';

import { driverDocuments, saveDriverDocument } from '../api';
import {
  DRIVER_DOCUMENT_TYPES,
  type DriverDocument,
  type DriverDocuments,
  type DriverDocumentType,
} from '../data-provider';

/**
 * Document verification, expanded inline under a driver's row.
 *
 * Owner decision D-018. This is the only way a document gets verified — without
 * it the endpoints have no caller and the policy could be switched on with no
 * way for anyone to satisfy it.
 *
 * v1 records that an administrator SAW a document: its number, who checked it,
 * and when it expires. There is no upload, so nothing here handles a file.
 */

const DOCUMENT_AR: Record<DriverDocumentType, string> = {
  NATIONAL_ID: 'البطاقة الوطنية',
  DRIVING_LICENCE: 'إجازة السوق',
  VEHICLE_REGISTRATION: 'سنوية المركبة',
  VEHICLE_AUTHORIZATION: 'إجازة العمل',
};

const STATUS_AR: Record<DriverDocument['status'], string> = {
  PENDING: 'بانتظار الفحص',
  VERIFIED: 'موثّقة',
  REJECTED: 'مرفوضة',
};

/**
 * Loaded on demand rather than with the driver list.
 *
 * Most days nobody opens this. Fetching it per row would add a read for every
 * driver to the one screen the business uses all day.
 */
export function Documents({ driverId }: { driverId: string }): JSX.Element {
  const [state, setState] = useState<DriverDocuments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    driverDocuments(driverId)
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // The row can be collapsed before the request lands.
    return () => {
      cancelled = true;
    };
  }, [driverId]);

  if (loading) return <p className="state">جارٍ تحميل الوثائق…</p>;
  if (error !== null) return <p className="state">{error}</p>;
  if (state === null) return <p className="state">لا توجد بيانات.</p>;

  const held = new Map(state.items.map((item) => [item.docType, item]));

  return (
    <div>
      <p>
        {state.compliance.compliant ? (
          <span className="tag">مستوفٍ للمطلوب</span>
        ) : (
          <span className="tag tag-danger">غير مستوفٍ — لا يستطيع الاتصال</span>
        )}{' '}
        <small>
          المطلوب يُضبط من الإعدادات. القائمة فارغة افتراضياً، أي لا وثيقة إلزامية.
        </small>
      </p>

      <table>
        <thead>
          <tr>
            <th>الوثيقة</th>
            <th>الحالة</th>
            <th>الرقم</th>
            <th>تنتهي</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {/* Every type is listed, held or not: an administrator needs to see
              what is absent, and a table of only what exists cannot show that. */}
          {DRIVER_DOCUMENT_TYPES.map((type) => (
            <DocumentRow
              key={type}
              driverId={driverId}
              docType={type}
              current={held.get(type) ?? null}
              onSaved={setState}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocumentRow({
  driverId,
  docType,
  current,
  onSaved,
}: {
  driverId: string;
  docType: DriverDocumentType;
  current: DriverDocument | null;
  onSaved: (next: DriverDocuments) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [reference, setReference] = useState(current?.reference ?? '');
  const [expiresAt, setExpiresAt] = useState(current?.expiresAt ?? '');
  const [note, setNote] = useState(current?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(status: DriverDocument['status']): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await saveDriverDocument(driverId, docType, {
        status,
        reference: reference.trim(),
        // Omitted rather than sent empty. The server reads an absent expiry as
        // "does not lapse", and '' fails the date format check.
        ...(expiresAt === '' ? {} : { expiresAt }),
        note: note.trim(),
      });
      onSaved(next);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Matches the server: a document is valid through the whole of its printed
  // day, so the comparison is against the end of it, not midnight.
  const expired =
    current?.status === 'VERIFIED' &&
    current.expiresAt !== null &&
    new Date(`${current.expiresAt}T23:59:59`) < new Date();

  return (
    <>
      <tr>
        <td>{DOCUMENT_AR[docType]}</td>
        <td>
          {current === null ? (
            <span className="tag">غير مسجّلة</span>
          ) : expired ? (
            <span className="tag tag-danger">منتهية</span>
          ) : (
            <span className={current.status === 'REJECTED' ? 'tag tag-danger' : 'tag'}>
              {STATUS_AR[current.status]}
            </span>
          )}
        </td>
        <td dir="ltr">{current?.reference === '' ? '—' : (current?.reference ?? '—')}</td>
        <td dir="ltr">{current?.expiresAt ?? '—'}</td>
        <td className="actions">
          <button onClick={() => setEditing((v) => !v)}>{editing ? 'إلغاء' : 'تسجيل'}</button>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={5}>
            <div className="inline-form">
              <input
                placeholder="رقم الوثيقة"
                dir="ltr"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
              <input
                type="date"
                aria-label="تاريخ الانتهاء"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
              <input
                placeholder="ملاحظة أو سبب الرفض"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button disabled={busy} onClick={() => void save('VERIFIED')}>
                توثيق
              </button>
              <button disabled={busy} onClick={() => void save('REJECTED')}>
                رفض
              </button>
              {error !== null && <span className="error">{error}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
