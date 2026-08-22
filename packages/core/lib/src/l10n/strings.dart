import 'package:flutter/widgets.dart';

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
  String get driverOnTheWay;
  String get driverHasArrived;
  String get onTrip;
  String get rideCompleted;
  String get cancelRide;
  String get cancelRideConfirm;
  String get rateYourDriver;
  String get submitRating;
  String get youAlreadyHaveARide;
  String get fareBreakdown;
  String get baseFare;
  String get distanceCharge;
  String get timeCharge;
  String get minimumFare;
  String get rounding;
  String get total;

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
}

/// Delegate. Arabic is the default for any locale that is not English.
class AppStringsDelegate extends LocalizationsDelegate<AppStrings> {
  const AppStringsDelegate();

  @override
  bool isSupported(Locale locale) => true;

  @override
  Future<AppStrings> load(Locale locale) async =>
      locale.languageCode == 'en' ? const EnglishStrings() : const ArabicStrings();

  @override
  bool shouldReload(AppStringsDelegate old) => false;
}
