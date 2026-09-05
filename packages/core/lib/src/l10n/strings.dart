import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import 'package:rideapp_core/src/compliance/compliance_failure.dart';
import 'package:rideapp_core/src/models/models.dart';

/// The localisation layer.
///
/// CLAUDE.md §8: "Never hardcode a user-facing string. All strings go through
/// the localization layer, including error messages and toasts."
///
/// Arabic is primary and RTL; English is the fallback. Both are held in one
/// class rather than generated ARB files so that a missing translation is a
/// COMPILE error — with ARB, a key missing from `ar` silently falls back to
/// English, and the first person to notice is an Iraqi driver looking at a
/// screen half in a language they may not read.
abstract class AppStrings {
  String get languageCode;

  // --- generic ---
  String get appNameRider;
  String get appNameDriver;
  String get ok;
  String get cancel;
  String get retry;
  String get confirm;
  String get back;
  String get loading;

  // --- Maps -----------------------------------------------------------------

  /// Title of the point-picking screen.
  String get pickOnMap;

  /// The map cannot render at all — a build configuration problem the user
  /// cannot fix, so it is worded as a statement rather than an instruction.
  String get mapUnavailable;

  String get offline;

  /// Location services are off at the OS level. The fix is settings, not a
  /// permission prompt.
  String get locationServicesOff;

  /// Refused once; can be asked again.
  String get locationPermissionNeeded;

  /// Refused permanently. Android will not show the dialog again, so the copy
  /// must send the user to settings instead of implying another prompt.
  String get locationPermissionBlocked;

  String get grantPermission;
  String get openSettings;

  // --- History, receipt, profile, earnings ---------------------------------

  String get rideHistory;
  String get receipt;
  String get rideNumber;
  String get requestedAt;
  String get completedAt;
  String get route;
  String get pickup;
  String get destination;
  String get driver;
  String get fare;
  String get estimated;
  String get distance;
  String get paymentMethod;
  String get cash;
  String get fareNotSettledYet;
  String get cancellationReason;
  String get profile;
  String get phone;
  String get saving;
  String get saved;
  String get displayName;
  String get save;
  String get signOut;

  // --- Account deletion (Google Play requires an in-app path) --------------

  String get deleteAccount;

  /// The confirmation prompt. Deliberately explicit about what survives:
  /// a user consenting to "delete everything" and later discovering their
  /// rides are still on file has been misled, even though retaining them is
  /// both necessary and disclosed.
  String get deleteAccountWarning;

  String get deleteAccountConfirm;

  /// Shown when a ride is in progress. The server refuses, and the reason is
  /// something the user can act on immediately.
  String get deleteAccountBlockedByRide;
  String get earnings;
  String get todayEarnings;
  String get totalEarnings;
  String get completedRides;
  String get statement;

  /// A ride status in the user's language.
  ///
  /// A method rather than a map so a new enum value fails to compile here
  /// instead of rendering its wire name to a user.
  String statusLabel(RideStatus status);


  String get somethingWentWrong;
  String get noInternet;
  String get sessionExpired;

  // --- auth ---
  String get signInTitle;
  String get phoneNumber;
  String get phoneHint;
  String get sendCode;
  String get enterCode;
  String get codeSentTo;
  String get verify;
  String get resendCode;
  String get invalidPhone;
  String get invalidCode;
  String get yourName;
  String get driverAccountNotFound;

  // --- rider ---
  String get whereTo;
  String get setPickup;
  String get setDestination;
  String get estimatedFare;
  String get requestRide;
  String get searchingForDriver;
  String get noDriversFound;

  /// Why nobody came, and what the rider can do about it. The status alone
  /// reads as a fault; this says it is not one.
  String get noDriversFoundBody;
  String get driverOnTheWay;
  String get driverHasArrived;
  String get onTrip;
  String get rideCompleted;
  String get cancelRide;
  String get cancelRideConfirm;
  String get rateYourDriver;
  String get submitRating;

  /// Shown after a rating lands — including the duplicate case, where it
  /// landed on an earlier attempt the rider never saw succeed.
  String get thankYou;
  String get ratingSubmitted;
  String get youAlreadyHaveARide;
  String get fareBreakdown;
  String get baseFare;
  String get distanceCharge;
  String get timeCharge;
  String get minimumFare;
  String get rounding;
  String get total;
  String get noRidesYet;
  String get noRidesYetHint;
  String get noEarningsYet;
  String get permissionDenied;

  // --- driver ---
  String get goOnline;
  String get goOffline;
  String get youAreOnline;
  String get youAreOffline;
  String get newRideOffer;
  String get accept;
  String get decline;
  String get offerExpired;
  String get rideNoLongerAvailable;
  String get navigateToPickup;
  String get iHaveArrived;
  String get startTrip;
  String get completeTrip;
  String get wallet;
  String get balance;
  String get finishRideBeforeGoingOffline;
  String get accountSuspended;

  // --- background location (CLAUDE.md §5.3) ---
  String get locationPermissionTitle;
  String get locationPermissionBody;
  String get backgroundLocationTitle;
  String get backgroundLocationBody;
  String get batteryExemptionTitle;
  String get batteryExemptionBody;
  String get batteryExemptionCta;
  String get notificationChannelName;
  String get foregroundServiceTitle;
  String get foregroundServiceBody;
  String get bufferedLocations;

  static AppStrings of(BuildContext context) =>
      Localizations.of<AppStrings>(context, AppStrings) ?? const ArabicStrings();

  // Disputes. A rider or driver reporting a problem with a finished ride.
  /// A distance, with its unit, in the user's language.
  ///
  /// A method because the unit is part of the translation: the receipt used to
  /// interpolate 'كم' directly, so an English UI read "3.2 كم".
  String distanceKm(double km);

  /// A required driver document, in the user's language.
  ///
  /// A method for the same reason as [statusLabel]: a document type added to
  /// the server enum must fail to compile here rather than show a driver the
  /// string `VEHICLE_AUTHORIZATION`.
  String documentLabel(DriverDocumentType type);

  /// Headline when the platform will not bring the driver online.
  String get cannotGoOnline;

  /// "Bring these documents" / "renew these" / "these were refused".
  String get documentsMissing;
  String get documentsExpired;
  String get documentsRejected;

  /// The server refused but named no document this build understands.
  String get documentsUnknownReason;

  String get loadMore;
  String get reportProblem;
  String get reportProblemPrompt;
  String get describeProblemOptional;
  String get submitReport;
  String get reportReceived;
  String get reportReference;

  /// A dispute reason in the user's language.
  ///
  /// A method for the same reason as [statusLabel]: adding a reason code to
  /// the server enum must fail to compile here rather than show an Iraqi rider
  /// the string `DRIVER_NO_SHOW`.
  String disputeReasonLabel(DisputeReason reason);

  // --- Driver mode: subscription and blockers (CLAUDE.md §1.1, §8) ----------
  //
  // These moved out of `design/components/driver.dart`, which hardcoded them in
  // Arabic with no English path at all - a §8 violation that widget tests were
  // asserting, so it would have shipped the moment those components were
  // mounted on a screen.

  String get subscriptionTitle;
  String get subscriptionExpired;

  /// `يتبقى يومان` / `2 days left`. Arabic needs the dual and the 3-10 plural,
  /// which is why this is a method and not an interpolated getter.
  String subscriptionRemaining(int days);

  String get subscriptionExpiresOn;
  String get subscriptionExpiredOn;
  String get subscriptionHintActive;
  String get subscriptionHintExpiringSoon;
  String get subscriptionHintExpired;
  String get renewSubscription;
  String get noActiveSubscription;
  String get noActiveSubscriptionHint;
  String get availablePlans;

  /// `30 يوماً` / `30 days`.
  String planDuration(int days);

  /// How a driver actually pays, which in v1 is in cash to an operator.
  /// DECISIONS.md D-019 keeps a live payment rail out of scope.
  String get subscriptionPurchaseHint;

  String get cannotGoOnlineNow;
  String get contactSupport;

  /// What is wrong, for one server blocker code.
  ///
  /// A method taking the raw code rather than an enum, deliberately: the server
  /// ships weekly and the Play Store review does not, so a driver WILL receive
  /// a code their build has never seen. An enum would fail to parse; this
  /// returns a real sentence for the unknown case and asks them to quote the
  /// code to support.
  String blockerTitle(String code);

  /// What to DO about it. Never a restatement of [blockerTitle].
  String blockerAction(String code);

  /// The button, or null where there is genuinely nothing to press - a pending
  /// review is waiting, and a button that "hurries it up" would be a lie.
  String? blockerActionLabel(String code);

}

/// Primary language. CLAUDE.md §8.
class ArabicStrings implements AppStrings {
  const ArabicStrings();

  @override
  String get languageCode => 'ar';

  @override
  String get appNameRider => 'راكب';
  @override
  String get appNameDriver => 'سائق';
  @override
  String get ok => 'حسناً';
  @override
  String get cancel => 'إلغاء';
  @override
  String get retry => 'إعادة المحاولة';
  @override
  String get confirm => 'تأكيد';
  @override
  String get back => 'رجوع';
  @override
  String get loading => 'جارٍ التحميل…';

  @override
  String get pickOnMap => 'اختر الموقع على الخريطة';

  @override
  String get mapUnavailable => 'الخريطة غير متاحة حالياً. تواصل مع الدعم.';

  @override
  String get offline => 'لا يوجد اتصال بالإنترنت.';

  @override
  String get locationServicesOff => 'خدمات الموقع مغلقة في إعدادات الجهاز.';

  @override
  String get locationPermissionNeeded =>
      'نحتاج إذن الموقع لتحديد نقطة الانطلاق. يمكنك اختيارها يدوياً أيضاً.';

  @override
  String get locationPermissionBlocked =>
      'إذن الموقع مرفوض نهائياً. افتح إعدادات التطبيق للسماح به.';

  @override
  String get grantPermission => 'السماح بالموقع';

  @override
  String get openSettings => 'فتح الإعدادات';

  @override
  String get rideHistory => 'رحلاتي';
  @override
  String get receipt => 'الإيصال';
  @override
  String get rideNumber => 'رقم الرحلة';
  @override
  String get requestedAt => 'وقت الطلب';
  @override
  String get completedAt => 'وقت الانتهاء';
  @override
  String get route => 'المسار';
  @override
  String get pickup => 'نقطة الانطلاق';
  @override
  String get destination => 'الوجهة';
  @override
  String get driver => 'السائق';
  @override
  String get fare => 'الأجرة';
  @override
  String get estimated => 'تقديري';
  @override
  String get distance => 'المسافة';
  @override
  String get paymentMethod => 'طريقة الدفع';
  @override
  String get cash => 'نقداً';
  @override
  String get fareNotSettledYet => 'لم تُحتسب الأجرة النهائية بعد.';
  @override
  String get cancellationReason => 'سبب الإلغاء';
  @override
  String get profile => 'حسابي';
  @override
  String get phone => 'رقم الهاتف';
  @override
  String get saving => 'جارٍ الحفظ…';
  @override
  String get saved => 'تم الحفظ';
  @override
  String get displayName => 'الاسم';
  @override
  String get save => 'حفظ';
  @override
  String get signOut => 'تسجيل الخروج';

  @override
  String get deleteAccount => 'حذف الحساب';

  @override
  String get deleteAccountWarning =>
      'سيُحذف رقم هاتفك واسمك نهائياً ولن تتمكن من استعادة الحساب. '
      'تبقى سجلات رحلاتك ومعاملاتك المالية محفوظة بدون اسمك، '
      'لأن القانون يلزمنا بحفظ السجلات المالية.';

  @override
  String get deleteAccountConfirm => 'نعم، احذف حسابي';

  @override
  String get deleteAccountBlockedByRide =>
      'لا يمكن حذف الحساب أثناء رحلة جارية. أنهِ الرحلة أو ألغِها أولاً.';
  @override
  String get earnings => 'الأرباح';
  @override
  String get todayEarnings => 'أرباح اليوم';
  @override
  String get totalEarnings => 'الرصيد الحالي';
  @override
  String get completedRides => 'الرحلات المكتملة';
  @override
  String get statement => 'كشف الحساب';

  @override
  String statusLabel(RideStatus status) => switch (status) {
        RideStatus.requested => 'قيد الطلب',
        RideStatus.offered => 'بانتظار سائق',
        RideStatus.accepted => 'السائق في الطريق',
        RideStatus.driverArrived => 'وصل السائق',
        RideStatus.inProgress => 'الرحلة جارية',
        RideStatus.completed => 'مكتملة',
        RideStatus.cancelledByRider => 'ألغيتها',
        RideStatus.cancelledByDriver => 'ألغاها السائق',
        RideStatus.cancelledInTrip => 'أُلغيت أثناء الرحلة',
        RideStatus.expired => 'انتهت المهلة',
        RideStatus.noDriversFound => 'لا يوجد سائق متاح',
      };


  @override
  String get somethingWentWrong => 'حدث خطأ. حاول مرة أخرى.';
  @override
  String get noInternet => 'لا يوجد اتصال بالإنترنت';
  @override
  String get sessionExpired => 'انتهت الجلسة. سجّل الدخول من جديد.';

  @override
  String get signInTitle => 'تسجيل الدخول';
  @override
  String get phoneNumber => 'رقم الهاتف';
  @override
  String get phoneHint => '07XXXXXXXXX';
  @override
  String get sendCode => 'إرسال الرمز';
  @override
  String get enterCode => 'أدخل الرمز';
  @override
  String get codeSentTo => 'أُرسل الرمز إلى';
  @override
  String get verify => 'تحقّق';
  @override
  String get resendCode => 'إعادة إرسال الرمز';
  @override
  String get invalidPhone => 'رقم هاتف عراقي غير صحيح';
  @override
  String get invalidCode => 'الرمز غير صحيح';
  @override
  String get yourName => 'اسمك';
  @override
  String get driverAccountNotFound =>
      'لا يوجد حساب سائق بهذا الرقم. راجع الإدارة لإنشائه.';

  @override
  String get whereTo => 'إلى أين؟';
  @override
  String get setPickup => 'حدّد نقطة الانطلاق';
  @override
  String get setDestination => 'حدّد الوجهة';
  @override
  String get estimatedFare => 'الأجرة التقديرية';
  @override
  String get requestRide => 'اطلب رحلة';
  @override
  String get searchingForDriver => 'جارٍ البحث عن سائق…';
  @override
  String get noDriversFound => 'لا يوجد سائقون متاحون الآن';
  @override
  String get noDriversFoundBody =>
      'لم يقبل أي سائق قريب طلبك. جرّب بعد قليل أو غيّر نقطة الانطلاق.';
  @override
  String get driverOnTheWay => 'السائق في الطريق إليك';
  @override
  String get driverHasArrived => 'السائق وصل';
  @override
  String get onTrip => 'الرحلة جارية';
  @override
  String get rideCompleted => 'انتهت الرحلة';
  @override
  String get cancelRide => 'إلغاء الرحلة';
  @override
  String get cancelRideConfirm => 'هل تريد إلغاء الرحلة؟';
  @override
  String get rateYourDriver => 'قيّم السائق';
  @override
  String get submitRating => 'إرسال التقييم';
  @override
  String get thankYou => 'شكراً لك';
  @override
  String get ratingSubmitted => 'وصل تقييمك، وهو يساعد سائقين آخرين.';
  @override
  String get youAlreadyHaveARide => 'لديك رحلة جارية بالفعل';
  @override
  String get fareBreakdown => 'تفاصيل الأجرة';
  @override
  String get baseFare => 'أجرة البداية';
  @override
  String get distanceCharge => 'المسافة';
  @override
  String get timeCharge => 'الوقت';
  @override
  String get minimumFare => 'الحد الأدنى';
  @override
  String get rounding => 'التقريب';
  @override
  String get total => 'المجموع';
  @override
  String get noRidesYet => 'لا توجد رحلات بعد';
  @override
  String get noRidesYetHint => 'رحلاتك السابقة ستظهر هنا';
  @override
  String get noEarningsYet => 'لا توجد أرباح بعد';
  @override
  String get permissionDenied => 'لم يُمنح الإذن. بدونه لا يمكن إكمال هذه الخطوة.';

  @override
  String get goOnline => 'اتصال';
  @override
  String get goOffline => 'قطع الاتصال';
  @override
  String get youAreOnline => 'أنت متصل';
  @override
  String get youAreOffline => 'أنت غير متصل';
  @override
  String get newRideOffer => 'طلب رحلة جديد';
  @override
  String get accept => 'قبول';
  @override
  String get decline => 'رفض';
  @override
  String get offerExpired => 'انتهت مهلة العرض';
  @override
  String get rideNoLongerAvailable => 'الرحلة لم تعد متاحة';
  @override
  String get navigateToPickup => 'التوجّه إلى الراكب';
  @override
  String get iHaveArrived => 'وصلت';
  @override
  String get startTrip => 'بدء الرحلة';
  @override
  String get completeTrip => 'إنهاء الرحلة';
  @override
  String get wallet => 'المحفظة';
  @override
  String get balance => 'الرصيد';
  @override
  String get finishRideBeforeGoingOffline =>
      'أنهِ رحلتك الحالية قبل قطع الاتصال';
  @override
  String get accountSuspended => 'حسابك موقوف. راجع الإدارة.';

  @override
  String get locationPermissionTitle => 'إذن الموقع';
  @override
  String get locationPermissionBody =>
      'نحتاج موقعك لنعرض رحلات قريبة منك ونُظهر موقعك للراكب أثناء الرحلة.';
  @override
  String get backgroundLocationTitle => 'الموقع في الخلفية';
  @override
  String get backgroundLocationBody =>
      'اختر «السماح طوال الوقت». بدون ذلك يتوقف موقعك عن التحديث عندما تُطفئ الشاشة، ويظن الراكب أنك لم تتحرك.';
  @override
  String get batteryExemptionTitle => 'استثناء من توفير البطارية';
  @override
  String get batteryExemptionBody =>
      'أندرويد يوقف التطبيقات في الخلفية لتوفير البطارية. بدون هذا الاستثناء سيتوقف إرسال موقعك بعد دقائق من إطفاء الشاشة، ولن تصلك طلبات رحلات.';
  @override
  String get batteryExemptionCta => 'السماح';
  @override
  String get notificationChannelName => 'حالة السائق';
  @override
  String get foregroundServiceTitle => 'أنت متصل';
  @override
  String get foregroundServiceBody => 'جارٍ استقبال طلبات الرحلات';
  @override
  String get bufferedLocations => 'مواقع بانتظار الإرسال';

  @override
  String distanceKm(double km) => '${km.toStringAsFixed(1)} كم';
  @override
  String documentLabel(DriverDocumentType type) => switch (type) {
        DriverDocumentType.nationalId => 'البطاقة الوطنية',
        DriverDocumentType.drivingLicence => 'إجازة السوق',
        DriverDocumentType.vehicleRegistration => 'سنوية المركبة',
        DriverDocumentType.vehicleAuthorization => 'إجازة العمل',
      };
  @override
  String get cannotGoOnline => 'لا يمكنك الاتصال حالياً';
  @override
  String get documentsMissing => 'وثائق مطلوبة';
  @override
  String get documentsExpired => 'وثائق منتهية الصلاحية - تحتاج تجديداً';
  @override
  String get documentsRejected => 'وثائق مرفوضة - راجع الإدارة';
  @override
  String get documentsUnknownReason =>
      'هناك وثيقة مطلوبة غير معروفة في هذا الإصدار. حدّث التطبيق أو راجع الإدارة.';
  @override
  String get loadMore => 'تحميل المزيد';
  @override
  String get reportProblem => 'الإبلاغ عن مشكلة';
  @override
  String get reportProblemPrompt => 'ما المشكلة في هذه الرحلة؟';
  @override
  String get describeProblemOptional => 'وصف المشكلة (اختياري)';
  @override
  String get submitReport => 'إرسال البلاغ';
  @override
  String get reportReceived => 'تم استلام بلاغك';
  @override
  String get reportReference => 'رقم البلاغ';

  @override
  String disputeReasonLabel(DisputeReason reason) => switch (reason) {
        DisputeReason.fareWrong => 'الأجرة غير صحيحة',
        DisputeReason.driverNoShow => 'السائق لم يحضر',
        DisputeReason.riderNoShow => 'الراكب لم يحضر',
        DisputeReason.unsafe => 'سلوك غير آمن',
        DisputeReason.other => 'مشكلة أخرى',
      };

  // --- Driver mode: subscription and blockers ------------------------------

  @override
  String get subscriptionTitle => 'الاشتراك';

  @override
  String get subscriptionExpired => 'انتهى الاشتراك';

  @override
  String subscriptionRemaining(int days) => 'يتبقى ${_arabicDays(days)}';

  @override
  String get subscriptionExpiresOn => 'ينتهي في';

  @override
  String get subscriptionExpiredOn => 'انتهى في';

  @override
  String get subscriptionHintActive => 'اشتراكك فعّال ويمكنك استقبال الطلبات.';

  @override
  String get subscriptionHintExpiringSoon => 'جدّد قبل انتهاء المدة حتى لا يتوقف عملك.';

  @override
  String get subscriptionHintExpired => 'لا يمكنك استقبال الطلبات حتى تجدّد اشتراكك.';

  @override
  String get renewSubscription => 'تجديد الاشتراك';

  @override
  String get noActiveSubscription => 'لا يوجد اشتراك فعّال';

  @override
  String get noActiveSubscriptionHint =>
      'اشترك لتتمكن من استقبال الطلبات عندما يُفعّل الاشتراك الإلزامي.';

  @override
  String get availablePlans => 'الباقات المتاحة';

  @override
  String planDuration(int days) => _arabicDays(days);

  @override
  String get subscriptionPurchaseHint =>
      'الدفع نقداً لدى مكتب الشركة. تواصل مع الدعم لتفعيل اشتراكك.';

  @override
  String get cannotGoOnlineNow => 'لا يمكنك الاتصال الآن';

  @override
  String get contactSupport => 'تواصل مع الدعم';

  @override
  String blockerTitle(String code) => switch (code) {
        'ACCOUNT_DISABLED' => 'حسابك معطّل',
        'NOT_A_DRIVER' => 'هذا الحساب ليس حساب سائق',
        'APPROVAL_PENDING' => 'طلبك قيد المراجعة',
        'APPROVAL_REJECTED' => 'تم رفض طلب الانضمام',
        'SUSPENDED' => 'حسابك موقوف مؤقتاً',
        'DOCUMENTS_INCOMPLETE' => 'مستنداتك غير مكتملة',
        'SUBSCRIPTION_REQUIRED' => 'اشتراكك غير فعّال',
        _ => 'هناك شرط غير مستوفٍ',
      };

  @override
  String blockerAction(String code) => switch (code) {
        'ACCOUNT_DISABLED' => 'تواصل مع الدعم لإعادة تفعيل حسابك قبل أن تتمكن من العمل.',
        'NOT_A_DRIVER' =>
          'سجّل الخروج وادخل برقم هاتف السائق، أو اطلب من الدعم تحويل حسابك.',
        'APPROVAL_PENDING' =>
          'أبقِ هاتفك متاحاً وانتظر إشعار الموافقة. لا حاجة لإرسال الطلب مرة أخرى.',
        'APPROVAL_REJECTED' => 'اسأل الدعم عن سبب الرفض، ثم أعد التقديم بعد معالجة الملاحظات.',
        'SUSPENDED' => 'تواصل مع الدعم لمعرفة سبب الإيقاف ومتى ينتهي.',
        'DOCUMENTS_INCOMPLETE' =>
          'زوّد الدعم بالهوية وسند السيارة وإجازة السوق ليكملوا ملفك.',
        'SUBSCRIPTION_REQUIRED' => 'جدّد اشتراكك لتتمكن من استقبال الطلبات.',
        _ => 'تواصل مع الدعم واذكر لهم الرمز الظاهر أدناه.',
      };

  @override
  String? blockerActionLabel(String code) => switch (code) {
        // Nothing to press: a review is already running, and a button implying
        // the driver can speed it up would be a lie.
        'APPROVAL_PENDING' => null,
        'SUBSCRIPTION_REQUIRED' => renewSubscription,
        _ => contactSupport,
      };

}

/// Secondary language, LTR.
class EnglishStrings implements AppStrings {
  const EnglishStrings();

  @override
  String get languageCode => 'en';

  @override
  String get appNameRider => 'Rider';
  @override
  String get appNameDriver => 'Driver';
  @override
  String get ok => 'OK';
  @override
  String get cancel => 'Cancel';
  @override
  String get retry => 'Retry';
  @override
  String get confirm => 'Confirm';
  @override
  String get back => 'Back';
  @override
  String get loading => 'Loading…';

  @override
  String get pickOnMap => 'Pick a location';

  @override
  String get mapUnavailable => 'The map is unavailable. Please contact support.';

  @override
  String get offline => 'No internet connection.';

  @override
  String get locationServicesOff => 'Location services are turned off on this device.';

  @override
  String get locationPermissionNeeded =>
      'Location permission helps set your pickup point. You can also choose it manually.';

  @override
  String get locationPermissionBlocked =>
      'Location permission is permanently denied. Open app settings to allow it.';

  @override
  String get grantPermission => 'Allow location';

  @override
  String get openSettings => 'Open settings';

  @override
  String get rideHistory => 'My rides';
  @override
  String get receipt => 'Receipt';
  @override
  String get rideNumber => 'Ride number';
  @override
  String get requestedAt => 'Requested';
  @override
  String get completedAt => 'Completed';
  @override
  String get route => 'Route';
  @override
  String get pickup => 'Pickup';
  @override
  String get destination => 'Destination';
  @override
  String get driver => 'Driver';
  @override
  String get fare => 'Fare';
  @override
  String get estimated => 'Estimated';
  @override
  String get distance => 'Distance';
  @override
  String get paymentMethod => 'Payment';
  @override
  String get cash => 'Cash';
  @override
  String get fareNotSettledYet => 'The final fare has not been settled yet.';
  @override
  String get cancellationReason => 'Cancellation reason';
  @override
  String get profile => 'Profile';
  @override
  String get phone => 'Phone number';
  @override
  String get saving => 'Saving…';
  @override
  String get saved => 'Saved';
  @override
  String get displayName => 'Name';
  @override
  String get save => 'Save';
  @override
  String get signOut => 'Sign out';

  @override
  String get deleteAccount => 'Delete account';

  @override
  String get deleteAccountWarning =>
      'Your phone number and name will be permanently erased and the account '
      'cannot be recovered. Your ride and payment records are kept without '
      'your name, because we are required to retain financial records.';

  @override
  String get deleteAccountConfirm => 'Yes, delete my account';

  @override
  String get deleteAccountBlockedByRide =>
      'An account cannot be deleted during a ride. Finish or cancel it first.';
  @override
  String get earnings => 'Earnings';
  @override
  String get todayEarnings => "Today's earnings";
  @override
  String get totalEarnings => 'Current balance';
  @override
  String get completedRides => 'Completed rides';
  @override
  String get statement => 'Statement';

  @override
  String statusLabel(RideStatus status) => switch (status) {
        RideStatus.requested => 'Requested',
        RideStatus.offered => 'Finding a driver',
        RideStatus.accepted => 'Driver on the way',
        RideStatus.driverArrived => 'Driver arrived',
        RideStatus.inProgress => 'In progress',
        RideStatus.completed => 'Completed',
        RideStatus.cancelledByRider => 'You cancelled',
        RideStatus.cancelledByDriver => 'Driver cancelled',
        RideStatus.cancelledInTrip => 'Cancelled mid-trip',
        RideStatus.expired => 'Offer expired',
        RideStatus.noDriversFound => 'No driver available',
      };


  @override
  String get somethingWentWrong => 'Something went wrong. Please try again.';
  @override
  String get noInternet => 'No internet connection';
  @override
  String get sessionExpired => 'Your session expired. Please sign in again.';

  @override
  String get signInTitle => 'Sign in';
  @override
  String get phoneNumber => 'Phone number';
  @override
  String get phoneHint => '07XXXXXXXXX';
  @override
  String get sendCode => 'Send code';
  @override
  String get enterCode => 'Enter the code';
  @override
  String get codeSentTo => 'Code sent to';
  @override
  String get verify => 'Verify';
  @override
  String get resendCode => 'Resend code';
  @override
  String get invalidPhone => 'Not a valid Iraqi mobile number';
  @override
  String get invalidCode => 'That code is not correct';
  @override
  String get yourName => 'Your name';
  @override
  String get driverAccountNotFound =>
      'No driver account exists for this number. Contact the operator.';

  @override
  String get whereTo => 'Where to?';
  @override
  String get setPickup => 'Set pickup';
  @override
  String get setDestination => 'Set destination';
  @override
  String get estimatedFare => 'Estimated fare';
  @override
  String get requestRide => 'Request a ride';
  @override
  String get searchingForDriver => 'Finding you a driver…';
  @override
  String get noDriversFound => 'No drivers available right now';
  @override
  String get noDriversFoundBody =>
      'No nearby driver took your request. Try again shortly, or move your '
      'pickup point.';
  @override
  String get driverOnTheWay => 'Your driver is on the way';
  @override
  String get driverHasArrived => 'Your driver has arrived';
  @override
  String get onTrip => 'On the way';
  @override
  String get rideCompleted => 'Ride completed';
  @override
  String get cancelRide => 'Cancel ride';
  @override
  String get cancelRideConfirm => 'Cancel this ride?';
  @override
  String get rateYourDriver => 'Rate your driver';
  @override
  String get submitRating => 'Submit';
  @override
  String get thankYou => 'Thank you';
  @override
  String get ratingSubmitted =>
      'Your rating was received, and it helps other riders.';
  @override
  String get youAlreadyHaveARide => 'You already have a ride in progress';
  @override
  String get fareBreakdown => 'Fare breakdown';
  @override
  String get baseFare => 'Base fare';
  @override
  String get distanceCharge => 'Distance';
  @override
  String get timeCharge => 'Time';
  @override
  String get minimumFare => 'Minimum fare';
  @override
  String get rounding => 'Rounding';
  @override
  String get total => 'Total';
  @override
  String get noRidesYet => 'No rides yet';
  @override
  String get noRidesYetHint => 'Your past rides will appear here';
  @override
  String get noEarningsYet => 'No earnings yet';
  @override
  String get permissionDenied => 'Permission was not granted. This step cannot continue without it.';

  @override
  String get goOnline => 'Go online';
  @override
  String get goOffline => 'Go offline';
  @override
  String get youAreOnline => 'You are online';
  @override
  String get youAreOffline => 'You are offline';
  @override
  String get newRideOffer => 'New ride request';
  @override
  String get accept => 'Accept';
  @override
  String get decline => 'Decline';
  @override
  String get offerExpired => 'The offer expired';
  @override
  String get rideNoLongerAvailable => 'This ride is no longer available';
  @override
  String get navigateToPickup => 'Navigate to pickup';
  @override
  String get iHaveArrived => 'I have arrived';
  @override
  String get startTrip => 'Start trip';
  @override
  String get completeTrip => 'Complete trip';
  @override
  String get wallet => 'Wallet';
  @override
  String get balance => 'Balance';
  @override
  String get finishRideBeforeGoingOffline =>
      'Finish your current ride before going offline';
  @override
  String get accountSuspended => 'Your account is suspended. Contact the operator.';

  @override
  String get locationPermissionTitle => 'Location permission';
  @override
  String get locationPermissionBody =>
      'We need your location to show you nearby rides and to show the rider where you are during a trip.';
  @override
  String get backgroundLocationTitle => 'Background location';
  @override
  String get backgroundLocationBody =>
      'Choose "Allow all the time". Without it your location stops updating when the screen is off, and the rider thinks you have not moved.';
  @override
  String get batteryExemptionTitle => 'Battery optimisation';
  @override
  String get batteryExemptionBody =>
      'Android stops background apps to save battery. Without this exemption your location stops sending minutes after the screen goes off, and you will not receive ride requests.';
  @override
  String get batteryExemptionCta => 'Allow';
  @override
  String get notificationChannelName => 'Driver status';
  @override
  String get foregroundServiceTitle => 'You are online';
  @override
  String get foregroundServiceBody => 'Receiving ride requests';
  @override
  String get bufferedLocations => 'Locations waiting to send';

  @override
  String distanceKm(double km) => '${km.toStringAsFixed(1)} km';
  @override
  String documentLabel(DriverDocumentType type) => switch (type) {
        DriverDocumentType.nationalId => 'National ID',
        DriverDocumentType.drivingLicence => 'Driving licence',
        DriverDocumentType.vehicleRegistration => 'Vehicle registration',
        DriverDocumentType.vehicleAuthorization => 'Operating permit',
      };
  @override
  String get cannotGoOnline => 'You cannot go online yet';
  @override
  String get documentsMissing => 'Documents required';
  @override
  String get documentsExpired => 'Documents expired - renewal needed';
  @override
  String get documentsRejected => 'Documents rejected - contact the office';
  @override
  String get documentsUnknownReason =>
      'A required document is not recognised by this version. Update the app or contact the office.';
  @override
  String get loadMore => 'Load more';
  @override
  String get reportProblem => 'Report a problem';
  @override
  String get reportProblemPrompt => 'What went wrong with this ride?';
  @override
  String get describeProblemOptional => 'Describe the problem (optional)';
  @override
  String get submitReport => 'Submit report';
  @override
  String get reportReceived => 'Your report was received';
  @override
  String get reportReference => 'Report number';

  @override
  String disputeReasonLabel(DisputeReason reason) => switch (reason) {
        DisputeReason.fareWrong => 'The fare is wrong',
        DisputeReason.driverNoShow => 'The driver did not arrive',
        DisputeReason.riderNoShow => 'The rider did not arrive',
        DisputeReason.unsafe => 'Unsafe behaviour',
        DisputeReason.other => 'Something else',
      };

  // --- Driver mode: subscription and blockers ------------------------------

  @override
  String get subscriptionTitle => 'Subscription';

  @override
  String get subscriptionExpired => 'Subscription expired';

  @override
  String subscriptionRemaining(int days) => days == 1 ? '1 day left' : '$days days left';

  @override
  String get subscriptionExpiresOn => 'Expires on';

  @override
  String get subscriptionExpiredOn => 'Expired on';

  @override
  String get subscriptionHintActive => 'Your subscription is active. You can take rides.';

  @override
  String get subscriptionHintExpiringSoon =>
      'Renew before it runs out so your work is not interrupted.';

  @override
  String get subscriptionHintExpired => 'You cannot take rides until you renew.';

  @override
  String get renewSubscription => 'Renew subscription';

  @override
  String get noActiveSubscription => 'No active subscription';

  @override
  String get noActiveSubscriptionHint =>
      'Subscribe so you can keep taking rides once subscriptions become required.';

  @override
  String get availablePlans => 'Available plans';

  @override
  String planDuration(int days) => days == 1 ? '1 day' : '$days days';

  @override
  String get subscriptionPurchaseHint =>
      'Paid in cash at the office. Contact support to activate your subscription.';

  @override
  String get cannotGoOnlineNow => 'You cannot go online yet';

  @override
  String get contactSupport => 'Contact support';

  @override
  String blockerTitle(String code) => switch (code) {
        'ACCOUNT_DISABLED' => 'Your account is disabled',
        'NOT_A_DRIVER' => 'This is not a driver account',
        'APPROVAL_PENDING' => 'Your application is under review',
        'APPROVAL_REJECTED' => 'Your application was rejected',
        'SUSPENDED' => 'Your account is temporarily suspended',
        'DOCUMENTS_INCOMPLETE' => 'Your documents are incomplete',
        'SUBSCRIPTION_REQUIRED' => 'Your subscription is not active',
        _ => 'A requirement is not met',
      };

  @override
  String blockerAction(String code) => switch (code) {
        'ACCOUNT_DISABLED' =>
          'Contact support to reactivate your account before you can work.',
        'NOT_A_DRIVER' =>
          'Sign out and sign in with the driver phone number, or ask support to convert your account.',
        'APPROVAL_PENDING' =>
          'Keep your phone available and wait for the approval notification. There is no need to apply again.',
        'APPROVAL_REJECTED' =>
          'Ask support why it was rejected, then reapply once it is resolved.',
        'SUSPENDED' => 'Contact support to find out why and when it ends.',
        'DOCUMENTS_INCOMPLETE' =>
          'Give support your ID, vehicle registration and driving licence to complete your file.',
        'SUBSCRIPTION_REQUIRED' => 'Renew your subscription so you can take rides.',
        _ => 'Contact support and quote the code shown below.',
      };

  @override
  String? blockerActionLabel(String code) => switch (code) {
        'APPROVAL_PENDING' => null,
        'SUBSCRIPTION_REQUIRED' => renewSubscription,
        _ => contactSupport,
      };

}

/// Delegate. Arabic is the default for any locale that is not English.
class AppStringsDelegate extends LocalizationsDelegate<AppStrings> {
  const AppStringsDelegate();

  @override
  bool isSupported(Locale locale) => true;

  /// Resolves on the SAME frame, not a later one.
  ///
  /// Both string tables are `const` objects that are already in memory, so
  /// there is nothing to await. Returning a real `Future` here made
  /// `Localizations` report itself unready for the first frame, and every
  /// screen under it rendered empty until the microtask queue drained - a
  /// blank flash on every cold start, for data that was never loading.
  ///
  /// `SynchronousFuture` is the mechanism Flutter provides for exactly this,
  /// and it is what `flutter_localizations` itself uses.
  @override
  Future<AppStrings> load(Locale locale) => SynchronousFuture<AppStrings>(
        locale.languageCode == 'en' ? const EnglishStrings() : const ArabicStrings(),
      );

  @override
  bool shouldReload(AppStringsDelegate old) => false;
}

/// The driver's remaining days, in Arabic, with the plural forms actually used.
///
/// `يوم واحد` / `يومان` / `3 أيام` / `11 يوماً`.
///
/// Arabic has singular, dual and two plural agreements. `$n أيام` for every
/// value reads as broken Arabic to a native speaker in exactly the way
/// `1 days` reads in English - and this string sits on the element that tells a
/// driver whether they can work tomorrow, so it is worth getting right.
///
/// Arabic counts in four shapes, not two: singular, dual, the 3-10 plural, and
/// the 11+ accusative singular. Interpolating `$days أيام` is wrong for three
/// of those four, which is why the caller is a method and not a getter.
String _arabicDays(int days) => switch (days) {
      1 => 'يوم واحد',
      2 => 'يومان',
      >= 3 && <= 10 => '$days أيام',
      _ => '$days يوماً',
    };
