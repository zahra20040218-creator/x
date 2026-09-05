// DEV-ONLY. Not shipped, not referenced by `main.dart`.
//
// A gallery that renders every ALY screen against a fake ApiClient, so the
// design can be reviewed on a device without the backend, Firebase OTP or a
// Maps key. Delete this file freely; nothing imports it.
//
// Run with:
//   flutter run -t lib/design_preview.dart -d emulator-5554
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:rideapp_aly/location/file_buffer_storage.dart';
import 'package:rideapp_aly/location/location_service.dart';
import 'package:rideapp_aly/screens/battery_exemption_screen.dart';
import 'package:rideapp_aly/screens/earnings_screen.dart';
import 'package:rideapp_aly/screens/home_screen.dart';
import 'package:rideapp_aly/screens/offer_sheet.dart';
import 'package:rideapp_aly/screens/profile_screen.dart';
import 'package:rideapp_aly/screens/request_ride_screen.dart';
import 'package:rideapp_aly/screens/ride_history_screen.dart';
import 'package:rideapp_aly/screens/ride_receipt_screen.dart';
import 'package:rideapp_aly/screens/subscription_screen.dart';
import 'package:rideapp_aly/screens/track_ride_screen.dart';
import 'package:rideapp_aly/screens/trip_screen.dart';
import 'package:rideapp_core/rideapp_core.dart';

void main() => runApp(const PreviewApp());

// ---------------------------------------------------------------- fake data

final _now = DateTime.now().toUtc();

const _pickup = LatLng(lat: 33.3152, lng: 44.3661);
const _dropoff = LatLng(lat: 33.3406, lng: 44.4009);

const _driver = PublicUser(
  id: 'drv-1',
  displayName: 'ابو علي',
  rating: 4.8,
  vehicle: Vehicle(plate: '12345 بغداد', model: 'كيا ريو', color: 'ابيض'),
);

const _rider = PublicUser(id: 'rdr-1', displayName: 'حسين');

Ride _ride(RideStatus status) => Ride(
      id: 'ride-0001',
      status: status,
      pickup: _pickup,
      dropoff: _dropoff,
      pickupAddress: 'ساحة التحرير',
      dropoffAddress: 'الكرادة داخل',
      estimatedFareIqd: const IqdAmount(10500),
      estimatedDistanceM: 6400,
      estimatedDurationS: 1080,
      requestedAt: _now.subtract(const Duration(minutes: 20)),
      rider: _rider,
      driver: _driver,
      acceptedAt: _now.subtract(const Duration(minutes: 18)),
      driverArrivedAt: _now.subtract(const Duration(minutes: 15)),
      startedAt: _now.subtract(const Duration(minutes: 12)),
      completedAt: status == RideStatus.completed ? _now : null,
      finalFareIqd:
          status == RideStatus.completed ? const IqdAmount(10500) : null,
      commissionIqd: status == RideStatus.completed ? IqdAmount.zero : null,
      actualDistanceM: status == RideStatus.completed ? 6600 : null,
    );

/// Every screen in the gallery talks to this instead of the network.
class _FakeApi extends ApiClient {
  _FakeApi() : super(baseUrl: 'http://localhost/v1', tokens: _NullTokens());

  @override
  Future<Me> me() async => const Me(
        id: 'usr-1',
        role: UserRole.driver,
        displayName: 'ابو علي',
        phone: '+9647700000001',
        rating: 4.8,
        availability: DriverAvailability.online,
        vehicle: Vehicle(plate: '12345 بغداد', model: 'كيا ريو', color: 'ابيض'),
        walletBalanceIqd: IqdAmount(84000),
      );

  @override
  Future<Me> updateMe({required String displayName}) => me();

  @override
  Future<Capabilities> capabilities() async => const Capabilities(
        userId: 'usr-1',
        canRide: true,
        driver: DriverCapability(
          allowed: true,
          blockers: [],
          suspendedReason: null,
          missingDocuments: [],
          expiredDocuments: [],
          rejectedDocuments: [],
          subscriptionExpiresAt: null,
        ),
      );

  @override
  Future<FareEstimate> estimateFare({
    required LatLng pickup,
    required LatLng dropoff,
  }) async =>
      const FareEstimate(
        estimatedFareIqd: IqdAmount(10500),
        distanceM: 6400,
        durationS: 1080,
        breakdown: FareBreakdown(
          baseIqd: IqdAmount(2000),
          distanceIqd: IqdAmount(7500),
          timeIqd: IqdAmount(1500),
          minimumAppliedIqd: IqdAmount.zero,
          roundingIqd: IqdAmount(-500),
        ),
      );

  @override
  Future<List<Ride>> myRides({int limit = 20, RideStatus? status}) async => [
        _ride(RideStatus.completed),
        _ride(RideStatus.cancelledByRider),
        _ride(RideStatus.completed),
      ];

  @override
  Future<Ride> getRide(String rideId) async => _ride(RideStatus.inProgress);

  @override
  Future<WalletBalance> wallet() async =>
      const WalletBalance(driverId: 'usr-1', balanceIqd: IqdAmount(84000));

  @override
  Future<LedgerPage> walletEntries({int limit = 50, String? cursor}) async =>
      LedgerPage(
        items: [
          LedgerEntry(
            id: 'le-1',
            transactionId: 'tx-1',
            accountType: 'DRIVER_WALLET',
            direction: 'CREDIT',
            amountIqd: const IqdAmount(10500),
            description: 'اجرة رحلة',
            createdAt: _now.subtract(const Duration(hours: 1)),
            rideId: 'ride-0001',
          ),
          LedgerEntry(
            id: 'le-2',
            transactionId: 'tx-2',
            accountType: 'DRIVER_WALLET',
            direction: 'DEBIT',
            amountIqd: const IqdAmount(25000),
            description: 'اشتراك شهري',
            createdAt: _now.subtract(const Duration(days: 2)),
          ),
        ],
        nextCursor: null,
      );

  @override
  Future<List<SubscriptionPlan>> subscriptionPlans() async => const [
        SubscriptionPlan(
          code: 'WEEKLY',
          nameAr: 'اشتراك اسبوعي',
          nameEn: 'Weekly',
          priceIqd: IqdAmount(10000),
          durationDays: 7,
        ),
        SubscriptionPlan(
          code: 'MONTHLY',
          nameAr: 'اشتراك شهري',
          nameEn: 'Monthly',
          priceIqd: IqdAmount(25000),
          durationDays: 30,
        ),
      ];

  @override
  Future<DriverSubscription?> mySubscription() async => DriverSubscription(
        id: 'sub-1',
        planCode: 'MONTHLY',
        status: 'ACTIVE',
        chargedIqd: const IqdAmount(25000),
        startedAt: _now.subtract(const Duration(days: 8)),
        expiresAt: _now.add(const Duration(days: 22)),
        transactionId: 'tx-2',
      );

  @override
  Future<RideOffer?> currentOffer() async => null;

  @override
  Future<String?> currentAccessToken() async => 'preview';
}

class _NullTokens implements TokenStore {
  @override
  Future<String?> accessToken() async => 'preview';

  @override
  Future<String?> refreshToken() async => 'preview';

  @override
  Future<void> save({
    required String accessToken,
    required String refreshToken,
  }) async {}

  @override
  Future<void> clear() async {}
}

// ------------------------------------------------------------------- gallery

class PreviewApp extends StatelessWidget {
  const PreviewApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ALY - design preview',
      theme: AlyTheme.light(),
      // Both themes are built and tested; only the wiring was missing.
      // A driver working a night shift in Baghdad was being handed a
      // white screen because the app never offered the dark one.
      // Follows the OS setting, which is `ThemeMode.system` by default and so
      // is not restated here — the linter rejects the redundant argument.
      darkTheme: AlyTheme.dark(),
      locale: const Locale('ar'),
      supportedLocales: const [Locale('ar'), Locale('en')],
      localizationsDelegates: const [
        AppStringsDelegate(),
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      builder: (context, child) => Directionality(
        textDirection: TextDirection.rtl,
        child: child ?? const SizedBox.shrink(),
      ),
      home: const _Gallery(),
    );
  }
}

class _Gallery extends StatelessWidget {
  const _Gallery();

  @override
  Widget build(BuildContext context) {
    final api = _FakeApi();
    final strings = AppStrings.of(context);

    final entries = <MapEntry<String, Widget Function()>>[
      MapEntry(
        'طلب رحلة - الراكب',
        () => RequestRideScreen(api: api, onSignedOut: () {}),
      ),
      MapEntry(
        'اختيار موقع على الخريطة',
        () => const MapPickerScreen(title: 'نقطة الانطلاق'),
      ),
      MapEntry(
        'تتبع الرحلة - الراكب',
        () => TrackRideScreen(api: api, ride: _ride(RideStatus.inProgress)),
      ),
      MapEntry(
        'الرحلة الجارية - السائق',
        () => TripScreen(
          api: api,
          ride: _ride(RideStatus.inProgress),
          onFinished: () async {},
        ),
      ),
      MapEntry(
        'عرض رحلة على السائق',
        () => Scaffold(
          body: Center(
            child: OfferSheet(
              api: api,
              offer: RideOffer(
                offerId: 'off-1',
                rideId: 'ride-0001',
                pickup: _pickup,
                dropoff: _dropoff,
                pickupAddress: 'ساحة التحرير',
                dropoffAddress: 'الكرادة داخل',
                estimatedFareIqd: const IqdAmount(10500),
                distanceM: 6400,
                expiresAt:
                    DateTime.now().toUtc().add(const Duration(seconds: 25)),
              ),
            ),
          ),
        ),
      ),
      MapEntry('الارباح والمحفظة', () => EarningsScreen(api: api)),
      MapEntry('الاشتراك', () => SubscriptionScreen(api: api)),
      MapEntry('سجل الرحلات', () => RideHistoryScreen(api: api)),
      MapEntry(
        'ايصال الرحلة',
        () => RideReceiptScreen(api: api, ride: _ride(RideStatus.completed)),
      ),
      MapEntry(
        'الملف الشخصي',
        () => ProfileScreen(api: api, onSignedOut: () {}),
      ),
      MapEntry(
        'اعفاء البطارية',
        () => BatteryExemptionScreen(onComplete: () {}),
      ),
      MapEntry(
        'الرئيسية - السائق',
        () => DriverHomeScreen(
          api: api,
          location: DriverLocationService(
            api: api,
            buffer: LocationBuffer(
              storage: FileBufferStorage('/data/local/tmp/preview_buffer.json'),
            ),
            strings: strings,
          ),
          onSignedOut: () {},
        ),
      ),
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('ALY - معاينة التصميم')),
      body: ListView.separated(
        itemCount: entries.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final entry = entries[i];
          return ListTile(
            title: Text(entry.key),
            trailing: const Icon(Icons.chevron_left_rounded),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => entry.value()),
            ),
          );
        },
      ),
    );
  }
}
