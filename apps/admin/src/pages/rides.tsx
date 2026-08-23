import { useList } from '@refinedev/core';

import { formatDateTime, formatIqd } from '../money';

/**
 * Ride history — the operator's answer to "what happened on this trip".
 *
 * Read-only on purpose. Every state change belongs to `RideStateMachine`
 * (CLAUDE.md §4), and an admin button that flipped `status` directly would
 * bypass the one component that guarantees transitions are legal and recorded.
 * A ride that genuinely must be intervened on goes through the dispute flow.
 */

interface Ride {
  id: string;
  status: string;
  estimatedFareIqd: number;
  finalFareIqd: number | null;
  commissionIqd: number | null;
  paymentMethod: string;
  requestedAt: string;
  completedAt: string | null;
  driver: { displayName?: string } | null;
}

const STATUS_AR: Record<string, string> = {
  REQUESTED: 'مطلوبة',
  OFFERED: 'معروضة',
  ACCEPTED: 'مقبولة',
  DRIVER_ARRIVED: 'وصل السائق',
  IN_PROGRESS: 'جارية',
  COMPLETED: 'مكتملة',
  EXPIRED: 'انتهت المهلة',
  NO_DRIVERS_FOUND: 'لا يوجد سائق',
  CANCELLED_BY_RIDER: 'ألغاها الراكب',
  CANCELLED_BY_DRIVER: 'ألغاها السائق',
  CANCELLED_IN_TRIP: 'أُلغيت أثناء الرحلة',
};

const TERMINAL_BAD = new Set([
  'NO_DRIVERS_FOUND',
  'CANCELLED_BY_RIDER',
  'CANCELLED_BY_DRIVER',
  'CANCELLED_IN_TRIP',
  'EXPIRED',
]);

export function RidesPage(): JSX.Element {
  const { data, isLoading, isError, error, refetch } = useList<Ride>({
    resource: 'rides',
    pagination: { pageSize: 50 },
  });

  if (isLoading) return <p className="state">جارٍ التحميل…</p>;

  if (isError) {
    return (
      <div className="banner banner-error">
        <p>تعذّر تحميل الرحلات: {error?.message}</p>
        <button onClick={() => void refetch()}>إعادة المحاولة</button>
      </div>
    );
  }

  const rides = data?.data ?? [];

  if (rides.length === 0) {
    return (
      <section>
        <header className="page-header">
          <h1>الرحلات</h1>
        </header>
        <p className="state">لا توجد رحلات بعد.</p>
      </section>
    );
  }

  return (
    <section>
      <header className="page-header">
        <h1>الرحلات</h1>
        <button onClick={() => void refetch()}>تحديث</button>
      </header>

      <table>
        <thead>
          <tr>
            <th>الحالة</th>
            <th>السائق</th>
            <th>الأجرة</th>
            <th>العمولة</th>
            <th>الدفع</th>
            <th>طُلبت</th>
            <th>اكتملت</th>
          </tr>
        </thead>
        <tbody>
          {rides.map((ride) => (
            <tr key={ride.id} className={TERMINAL_BAD.has(ride.status) ? 'muted' : undefined}>
              <td>
                <span className={`tag${TERMINAL_BAD.has(ride.status) ? ' tag-danger' : ''}`}>
                  {STATUS_AR[ride.status] ?? ride.status}
                </span>
              </td>
              <td>{ride.driver?.displayName ?? '—'}</td>
              <td>
                {/* The estimate until the ride settles, then the real figure. */}
                {ride.finalFareIqd === null ? (
                  <span title="تقديري">~{formatIqd(ride.estimatedFareIqd)}</span>
                ) : (
                  formatIqd(ride.finalFareIqd)
                )}
              </td>
              <td>{ride.commissionIqd === null ? '—' : formatIqd(ride.commissionIqd)}</td>
              <td>{ride.paymentMethod === 'CASH' ? 'نقداً' : ride.paymentMethod}</td>
              <td>{formatDateTime(ride.requestedAt)}</td>
              <td>{formatDateTime(ride.completedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
