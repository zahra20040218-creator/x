# PRIOR_PROJECTS.md

خريطة المشاريع السابقة على هذا الجهاز، وما استُخرج منها وما لم يُستخرج ولماذا.

**الغرض من هذا الملف: ألا يُعاد المسح.** فحص ~17,000 ملف مكلف، وقد جرى مرة
واحدة في 2026-08-23. أي سؤال لاحق عن «ماذا كان في المشاريع القديمة» يُجاب من
هنا لا بإعادة القراءة.

---

## ما هو موجود

| المشروع | المسار | التقنية | ملفات |
|---|---|---|---|
| aaly-wasla-mobility-workspace | `OneDrive/.../Mobility_and_Baly/` | android + backend + web | 11,802 |
| darb-app | `.../darb-baly-workspace/darb-app` | React + Vite + Capacitor + Firebase | 2,255 |
| aaly-native/mobile (Darb mobile) | `C:\aaly-native\mobile` | Expo / React Native | 1,557 |
| ali-mobility-platform | `.../Mobility_and_Baly/` | monorepo: apps/mobile/packages/services | 1,057 |
| baly-web | `.../Mobility_and_Baly/` | Next.js + Drizzle | 65 |

إضافةً إلى: محاكي أندرويد مُعدّ (`Mobility_Integration_API34.avd`).

## لماذا لم يُنسخ أي كود

المشاريع السابقة بـ React Native و Kotlin/Compose و React. المشروع الحالي
Flutter/Dart. النقل بين هذه اللغات **إعادة كتابة لا إعادة استخدام**، وكلفتها
أعلى من الكتابة المباشرة مع خطر أكبر: كود مترجم يدوياً من لغة أخرى يحمل
افتراضات المنصة الأصلية دون أن يحملها المترجم.

## ما استُخرج فعلاً — القرارات

القرارات تعبر حاجز اللغة، والكود لا يعبره.

### من `ANDROID_INVENTORY.md` (مشروع Kotlin/Compose المرجعي)

**حالات الخريطة المُعدَّدة** — قائمة مفيدة مباشرةً لأن الخرائط لم تُبنَ بعد هنا:

> loading · ready · style error · tiles timeout · offline · GPS disabled ·
> permission denied · permission permanently denied

`permission permanently denied` منفصلة عن `denied` لسبب حقيقي: أندرويد يتوقف
عن إظهار الحوار بعد رفضين، فالتطبيق الذي يعاملهما كحالة واحدة يترك السائق
أمام زر لا يفعل شيئاً. هذا بالضبط العيب الذي أُصلح في
`battery_exemption_screen.dart`.

**الصلاحيات في مشروعهم**: INTERNET، ACCESS_NETWORK_STATE، وموقع أمامي
(coarse/fine) فقط — **بلا خدمة موقع خلفية مسجّلة في Manifest**، مع ملاحظتهم
أن Expo أضافها لاحقاً لأنها مطلوبة لنطاق النقل. مشروعنا الحالي يسجّلها بالفعل
(‏`FOREGROUND_SERVICE_LOCATION` و`ACCESS_BACKGROUND_LOCATION`)، وهو الأصح
لـ CLAUDE.md §5.3.

**ممارسة جيدة تستحق النقل**: وثّقوا صراحةً أي عمليات يعرّفها العميل ولا
ينفّذها الخادم، ومنعوا ادّعاء التكافؤ قبل وجود عقد حقيقي. هذا نفس منطق
`docs/COMPLETION_MATRIX.md` هنا.

### من `خطة-درب-v3.md` (قرارات عمل)

مسجّلة في `docs/BLOCKERS.md` تحت BLOCKER-8، ومؤجّلة بقرار المالك.

## ما لم يُقرأ عمداً

- `baly-apk-analysis.md` و `darb.apk` المُفكَّك و `independent-baghdad-mobility-audit`
  — مادة هندسة عكسية لتطبيق شركة أخرى. `CLAUDE.md` §12 ونص المشروع نفسه
  يمنعان نسخ تنفيذ أو واجهة شركة أخرى، ولا يجوز استخراج كود منها.
- محتويات `node_modules` و `dist` و `build` في كل المشاريع.
- الشيفرة المصدرية لأي من المشاريع الخمسة — لسبب إعادة الكتابة أعلاه.

## ملاحظة تحقّق

`خطة-درب-v3.md` تقول إن درب «مبني وشغّال فعلاً اليوم» و«مبرمج في الكود حالياً».
لكن `darb-app` ما زال يحمل README الافتراضي لقالب Vite و`"name": "my-app"` في
`package.json`. عُمل فيه شغل حقيقي (pages، server، capacitor، firestore.rules)،
لكن **ادّعاء «شغّال» لم يُتحقَّق منه بالتشغيل**، ولا يجوز الاعتماد عليه قبل ذلك —
نفس القاعدة المطبَّقة على كل ادّعاء في هذا المستودع.
