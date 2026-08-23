import { useCustom, useCustomMutation } from '@refinedev/core';
import { useState } from 'react';

import { API_BASE_URL } from '../api';
import { formatIqd } from '../money';

/**
 * Fare and commission.
 *
 * This is the only screen on which the business makes or loses money, and it
 * is the reason `platform_config` exists rather than a constant: CLAUDE.md §6.5
 * requires the commission to change without a deploy.
 *
 * **The shipped default is zero.** A platform running on defaults earns nothing
 * per ride, and nothing in the system will ever point that out — so this page
 * does.
 */

type Config = Record<string, number>;

interface Field {
  key: string;
  label: string;
  hint: string;
  money?: boolean;
}

const FIELDS: Field[] = [
  {
    key: 'commission_bps',
    label: 'عمولة المنصة (نقاط أساس)',
    hint: '١٠٠ نقطة أساس = ١٪. القيمة صفر تعني أن المنصة لا تأخذ شيئاً.',
  },
  { key: 'fare_base_iqd', label: 'الأجرة الأساسية', hint: 'تُحتسب لكل رحلة.', money: true },
  { key: 'fare_per_km_iqd', label: 'لكل كيلومتر', money: true, hint: '' },
  { key: 'fare_per_minute_iqd', label: 'لكل دقيقة', money: true, hint: '' },
  { key: 'fare_minimum_iqd', label: 'الحد الأدنى للأجرة', money: true, hint: '' },
  {
    key: 'fare_rounding_iqd',
    label: 'التقريب',
    money: true,
    hint: 'تُقرَّب الأجرة النهائية إلى مضاعفات هذا المبلغ.',
  },
  {
    key: 'offer_timeout_seconds',
    label: 'مهلة عرض الرحلة (ثانية)',
    hint: 'بعدها تُعرض الرحلة على سائق آخر.',
  },
  { key: 'search_radius_meters', label: 'نطاق البحث (متر)', hint: '' },
];

export function ConfigPage(): JSX.Element {
  const { data, isLoading, refetch } = useCustom<Config>({
    url: `${API_BASE_URL}/admin/config`,
    method: 'get',
  });

  const { mutate, isLoading: saving } = useCustomMutation();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (isLoading) return <p className="state">جارٍ التحميل…</p>;

  const config = data?.data ?? {};
  const commission = Number(config['commission_bps'] ?? 0);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    setError(null);
    setSaved(false);

    // Only changed fields are sent. Sending the whole object would rewrite
    // values another operator changed while this page was open.
    const changed: Record<string, number> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (value !== '' && Number(value) !== Number(config[key])) {
        changed[key] = Number(value);
      }
    }

    if (Object.keys(changed).length === 0) {
      setError('لا يوجد تغيير.');
      return;
    }

    mutate(
      { url: `${API_BASE_URL}/admin/config`, method: 'put', values: changed },
      {
        onSuccess: () => {
          setDraft({});
          setSaved(true);
          void refetch();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  return (
    <section>
      <header className="page-header">
        <h1>الإعدادات والتسعير</h1>
      </header>

      {commission === 0 && (
        <div className="banner banner-warn">
          <strong>عمولة المنصة صفر.</strong>
          <p>
            التطبيق لا يحتفظ بأي مبلغ من أي رحلة حالياً — كل الأجرة تذهب للسائق.
            هذه هي القيمة الافتراضية المقصودة عند الإطلاق، لكن ما دامت صفراً فلا
            يوجد دخل مهما بلغ عدد الرحلات.
          </p>
        </div>
      )}

      {saved && <div className="banner banner-ok">تم الحفظ.</div>}
      {error && <div className="banner banner-error">{error}</div>}

      <form onSubmit={submit} className="card">
        <table>
          <thead>
            <tr>
              <th>الإعداد</th>
              <th>القيمة الحالية</th>
              <th>قيمة جديدة</th>
            </tr>
          </thead>
          <tbody>
            {FIELDS.map((field) => {
              const current = Number(config[field.key] ?? 0);
              return (
                <tr key={field.key}>
                  <td>
                    <div>{field.label}</div>
                    {field.hint && <small>{field.hint}</small>}
                  </td>
                  <td>
                    {field.money ? formatIqd(current) : current}
                    {field.key === 'commission_bps' && (
                      <small> ({(current / 100).toFixed(2)}٪)</small>
                    )}
                  </td>
                  <td>
                    <input
                      inputMode="numeric"
                      placeholder="—"
                      value={draft[field.key] ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [field.key]: e.target.value }))
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <p className="note">
          تغيير التسعير لا يؤثر على الرحلات المكتملة: كل رحلة تحتفظ بنسخة من
          العمولة التي حُسبت بها وقت إنشائها.
        </p>

        <button type="submit" disabled={saving}>
          {saving ? 'جارٍ الحفظ…' : 'حفظ'}
        </button>
      </form>
    </section>
  );
}
