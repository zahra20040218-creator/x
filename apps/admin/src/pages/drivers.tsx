import { useCreate, useList, useUpdate } from '@refinedev/core';
import { useState } from 'react';

import { topUp } from '../api';
import { formatDateTime, formatIqd } from '../money';

/**
 * Driver operations — the screen the business actually runs on.
 *
 * CLAUDE.md §2 puts driver self-signup and KYC out of scope for v1, so an
 * administrator creating drivers by hand is not a stopgap: it is the design.
 * That makes this page the only way a driver gets onto the platform at all.
 */

interface Driver {
  id: string;
  displayName: string;
  phone: string;
  availability: string;
  isSuspended: boolean;
  suspendedReason: string | null;
  rating: number | null;
  ridesCompleted: number;
  walletBalanceIqd: number;
  vehicle: { plate: string; model: string; color: string };
  createdAt: string;
}

const AVAILABILITY_AR: Record<string, string> = {
  ONLINE: 'متصل',
  OFFLINE: 'غير متصل',
  ON_TRIP: 'في رحلة',
};

export function DriversPage(): JSX.Element {
  const { data, isLoading, refetch } = useList<Driver>({
    resource: 'drivers',
    pagination: { pageSize: 50 },
  });

  const [creating, setCreating] = useState(false);

  if (isLoading) return <p className="state">جارٍ التحميل…</p>;

  const drivers = data?.data ?? [];

  return (
    <section>
      <header className="page-header">
        <h1>السائقون</h1>
        <button onClick={() => setCreating((v) => !v)}>
          {creating ? 'إلغاء' : 'إضافة سائق'}
        </button>
      </header>

      {creating && <CreateDriver onDone={() => { setCreating(false); void refetch(); }} />}

      {drivers.length === 0 ? (
        // An empty table with headers reads as "loading forever". Say it.
        <p className="state">لا يوجد سائقون بعد. أضف أول سائق للبدء.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>الاسم</th>
              <th>الهاتف</th>
              <th>المركبة</th>
              <th>الحالة</th>
              <th>الرحلات</th>
              <th>التقييم</th>
              <th>المحفظة</th>
              <th>أُضيف</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {drivers.map((driver) => (
              <DriverRow key={driver.id} driver={driver} onChanged={() => void refetch()} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DriverRow({
  driver,
  onChanged,
}: {
  driver: Driver;
  onChanged: () => void;
}): JSX.Element {
  const { mutate: update, isLoading } = useUpdate();
  const [toppingUp, setToppingUp] = useState(false);

  function toggleSuspension(): void {
    const suspending = !driver.isSuspended;

    // Suspension revokes the driver's sessions server-side (D-14/0006), so it
    // signs them out of every device. Worth confirming before it happens.
    const reason = suspending
      ? window.prompt(`سبب إيقاف ${driver.displayName}؟ سيتم تسجيل خروجه من كل الأجهزة.`)
      : null;
    if (suspending && reason === null) return;

    update(
      {
        resource: 'drivers',
        id: driver.id,
        values: suspending
          ? { isSuspended: true, suspendedReason: reason }
          : { isSuspended: false },
      },
      { onSuccess: onChanged },
    );
  }

  return (
    <>
      <tr className={driver.isSuspended ? 'suspended' : undefined}>
        <td>{driver.displayName}</td>
        <td dir="ltr">{driver.phone}</td>
        <td>
          {driver.vehicle.plate} — {driver.vehicle.model} ({driver.vehicle.color})
        </td>
        <td>
          {driver.isSuspended ? (
            <span className="tag tag-danger" title={driver.suspendedReason ?? undefined}>
              موقوف
            </span>
          ) : (
            <span className="tag">{AVAILABILITY_AR[driver.availability] ?? driver.availability}</span>
          )}
        </td>
        <td>{driver.ridesCompleted}</td>
        <td>{driver.rating ?? '—'}</td>
        <td>{formatIqd(driver.walletBalanceIqd)}</td>
        <td>{formatDateTime(driver.createdAt)}</td>
        <td className="actions">
          <button onClick={() => setToppingUp((v) => !v)}>شحن</button>
          <button onClick={toggleSuspension} disabled={isLoading}>
            {driver.isSuspended ? 'إلغاء الإيقاف' : 'إيقاف'}
          </button>
        </td>
      </tr>
      {toppingUp && (
        <tr>
          <td colSpan={9}>
            <TopUp
              driver={driver}
              onDone={() => {
                setToppingUp(false);
                onChanged();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function TopUp({ driver, onDone }: { driver: Driver; onDone: () => void }): JSX.Element {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The idempotency key is generated HERE, once, and reused if the request
      // is retried. Generating it inside the request would make every retry a
      // fresh top-up, which is how a driver gets credited twice.
      await topUp(driver.id, Number(amount), note, crypto.randomUUID());
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <span>
        شحن محفظة <strong>{driver.displayName}</strong>
      </span>
      <input
        inputMode="numeric"
        placeholder="المبلغ بالدينار"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
      />
      <input placeholder="ملاحظة" value={note} onChange={(e) => setNote(e.target.value)} />
      <button type="submit" disabled={busy || !/^\d+$/.test(amount)}>
        {busy ? 'جارٍ…' : 'تأكيد'}
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function CreateDriver({ onDone }: { onDone: () => void }): JSX.Element {
  const { mutate: create, isLoading } = useCreate();
  const [form, setForm] = useState({
    phone: '',
    displayName: '',
    vehiclePlate: '',
    vehicleModel: '',
    vehicleColor: '',
  });
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        create(
          { resource: 'drivers', values: form },
          {
            onSuccess: onDone,
            onError: (err) => setError(err.message),
          },
        );
      }}
    >
      <h2>سائق جديد</h2>
      <div className="grid">
        <label>
          الهاتف
          <input placeholder="07XXXXXXXXX" value={form.phone} onChange={set('phone')} required />
        </label>
        <label>
          الاسم
          <input value={form.displayName} onChange={set('displayName')} required />
        </label>
        <label>
          رقم اللوحة
          <input value={form.vehiclePlate} onChange={set('vehiclePlate')} required />
        </label>
        <label>
          الطراز
          <input value={form.vehicleModel} onChange={set('vehicleModel')} required />
        </label>
        <label>
          اللون
          <input value={form.vehicleColor} onChange={set('vehicleColor')} required />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={isLoading}>
        {isLoading ? 'جارٍ الإنشاء…' : 'إنشاء'}
      </button>
    </form>
  );
}
