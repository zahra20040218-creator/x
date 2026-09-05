# الحسم: الألوان تبقى تركوازية في فلاتر (لا نبدّلها للأزرق) — الويب يبقى منفصلاً عمداً. الخطوط: ما عندي ملفات .ttf، التعليمات أدناه تشرح من وين تجيبها.

## 1) تحميل خط Cairo/Tajawal فعلياً

نزّل من Google Fonts: Cairo (400,600,700) و Tajawal (400,500,700)، وضعهم في:
```
apps/aly/assets/fonts/Cairo-Regular.ttf
apps/aly/assets/fonts/Cairo-SemiBold.ttf
apps/aly/assets/fonts/Cairo-Bold.ttf
apps/aly/assets/fonts/Tajawal-Regular.ttf
```

أضف في `apps/aly/pubspec.yaml` (بعد `flutter:`):
```yaml
flutter:
  fonts:
    - family: Cairo
      fonts:
        - asset: assets/fonts/Cairo-Regular.ttf
        - asset: assets/fonts/Cairo-SemiBold.ttf
          weight: 600
        - asset: assets/fonts/Cairo-Bold.ttf
          weight: 700
    - family: Tajawal
      fonts:
        - asset: assets/fonts/Tajawal-Regular.ttf
```
ونفس الشي في `packages/core/pubspec.yaml` إذا الحزمة تحمّل الخط بنفسها. شغّل `flutter pub get` بعدها.

## 2) تفعيل الوضع الليلي — apps/aly/lib/main.dart

```diff
     return MaterialApp(
       onGenerateTitle: (context) => AppStrings.of(context).appNameRider,
       theme: AlyTheme.light(),
+      darkTheme: AlyTheme.dark(),
+      themeMode: ThemeMode.system,
       locale: const Locale('ar'),
```
(`AlyTheme.dark()` موجود وجاهز في `tokens/theme.dart` — فقط غير موصول.)

## 3) توحيد الأيقونات على عائلة `_rounded`

| ملف | القديم | الجديد |
|---|---|---|
| request_ride_screen.dart:151 | `Icons.person_outline` | `Icons.person_rounded` |
| request_ride_screen.dart:266 | `Icons.map_outlined` | `Icons.map_rounded` |
| home_screen.dart:474 | `Icons.logout` | `Icons.logout_rounded` |
| home_screen.dart:479 | `Icons.account_balance_wallet_outlined` | `Icons.account_balance_wallet_rounded` |
| home_screen.dart:488 | `Icons.person_outline` | `Icons.person_rounded` |
| home_screen.dart:500 | `Icons.card_membership_outlined` | `Icons.card_membership_rounded` |
| track_ride_screen.dart:281 | `Icons.star_border` | `Icons.star_outline_rounded` |
| profile_screen.dart:219 | `Icons.logout` | `Icons.logout_rounded` |
| trip_screen.dart:169 | `Icons.navigation_outlined` | `Icons.navigation_rounded` |
| trip_screen.dart:197 | `Icons.flag_outlined` | `Icons.flag_rounded` |
| battery_exemption_screen.dart:134-137 | `location_on_outlined` / `battery_saver_outlined` / `check_circle_outline` | `location_on_rounded` / `battery_saver_rounded` / `check_circle_rounded` |
| ride_receipt_screen.dart:150 | `Icons.flag_outlined` | `Icons.flag_rounded` |
| request_ride_screen.dart:142 | `Icons.receipt_long` | `Icons.receipt_long_rounded` |

(`Icons.trip_origin` و `Icons.place` بلا عائلة — تبقى كما هي.)

## 4) تفعيل `AlyMotion` — مثال في home_screen.dart

استبدل التبديل المباشر بين `TripScreen` والصفحة الرئيسية للسائق، وبين حالتي "متصل/غير متصل"، بـ `AnimatedSwitcher`:

```dart
AnimatedSwitcher(
  duration: AlyMotion.respecting(context, AlyMotion.medium),
  switchInCurve: AlyMotion.enter,
  switchOutCurve: AlyMotion.exit,
  child: ride != null
      ? TripScreen(key: const ValueKey('trip'), api: widget.api, ride: ride, onFinished: ...)
      : Scaffold(key: const ValueKey('home'), ...),
)
```
ونفس النمط على `_OnlineCard` عند تبديل `isOnline` (لفّ الأيقونة والنص بـ `AnimatedSwitcher` بدل التغيّر الفوري). طبّق النمط نفسه في أي شاشة فيها تبديل حالة واضح (عرض الرحلة، حالة الاشتراك).
