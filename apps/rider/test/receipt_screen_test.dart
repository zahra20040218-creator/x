import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:rideapp_rider/screens/ride_receipt_screen.dart';

/// The receipt.
///
/// The rider app had no tests at all. This covers the screen where getting it
/// wrong costs money or trust: the one that tells a rider what they were
/// charged.
///
/// The distinction these exist for is estimate versus settled fare. A receipt
/// that prints the estimate as though it were the amount charged is worse than
/// one that prints nothing — the rider has no way to tell the two apart, and
/// the number is wrong exactly when the ride went differently than expected.

class _StubApi implements ApiClient {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError('${invocation.memberName} is not used by these tests');
}

void main() {
  Ride ride({
    RideStatus status = RideStatus.completed,
    IqdAmount? finalFare,
    int? actualDistanceM,
    String? cancellationReason,
    PublicUser? driver,
  }) =>
      Ride(
        id: 'a1b2c3d4-0000-0000-0000-000000000000',
        status: status,
        pickup: const LatLng(lat: 33.3061, lng: 44.4213),
        dropoff: const LatLng(lat: 33.2989, lng: 44.4361),
        estimatedFareIqd: const IqdAmount(5000),
        estimatedDistanceM: 3200,
        estimatedDurationS: 600,
        requestedAt: DateTime.utc(2026, 8, 24, 6),
        finalFareIqd: finalFare,
        actualDistanceM: actualDistanceM,
        cancellationReason: cancellationReason,
        driver: driver,
        completedAt: status == RideStatus.completed ? DateTime.utc(2026, 8, 24, 6, 30) : null,
      );

  /// Matches the real app: Arabic, RTL, all four delegates. A harness that
  /// configures less than the app is not testing the app.
  Widget host(Ride value) => MaterialApp(
        locale: const Locale('ar'),
        supportedLocales: const [Locale('ar'), Locale('en')],
        localizationsDelegates: const [
          AppStringsDelegate(),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: RideReceiptScreen(ride: value, api: _StubApi()),
      );

  group('the fare', () {
    testWidgets('a settled fare is shown as the total', (tester) async {
      await tester.pumpWidget(host(ride(finalFare: const IqdAmount(7500))));
      await tester.pumpAndSettle();

      expect(find.text('المجموع'), findsOneWidget);
      expect(find.textContaining('7,500'), findsWidgets);
    });

    testWidgets('an unsettled fare is labelled an estimate, never a total', (tester) async {
      await tester.pumpWidget(host(ride(status: RideStatus.inProgress)));
      await tester.pumpAndSettle();

      // The distinction is the whole point of the screen.
      expect(find.text('المجموع'), findsNothing);
      expect(find.text('تقديري'), findsOneWidget);
      expect(find.text('لم تُحتسب الأجرة النهائية بعد.'), findsOneWidget);
    });

    testWidgets('payment method is stated, because v1 is cash', (tester) async {
      await tester.pumpWidget(host(ride(finalFare: const IqdAmount(5000))));
      await tester.pumpAndSettle();

      expect(find.text('نقداً'), findsOneWidget);
    });
  });

  group('what is rendered', () {
    testWidgets('the ride reference is short and reads left to right', (tester) async {
      await tester.pumpWidget(host(ride(finalFare: const IqdAmount(5000))));
      await tester.pumpAndSettle();

      // A full UUID is unreadable; a rider only needs enough to quote.
      expect(find.text('A1B2C3D4'), findsOneWidget);
    });

    testWidgets('never shows a raw status enum', (tester) async {
      await tester.pumpWidget(host(ride(finalFare: const IqdAmount(5000))));
      await tester.pumpAndSettle();

      expect(find.text('COMPLETED'), findsNothing);
    });

    testWidgets('the cancellation reason appears only when there is one', (tester) async {
      await tester.pumpWidget(host(ride(finalFare: const IqdAmount(5000))));
      await tester.pumpAndSettle();
      expect(find.text('سبب الإلغاء'), findsNothing);

      await tester.pumpWidget(host(ride(
        status: RideStatus.cancelledByDriver,
        cancellationReason: 'السائق لم يستطع الوصول',
      )));
      await tester.pumpAndSettle();
      expect(find.text('سبب الإلغاء'), findsOneWidget);
    });

    testWidgets('a ride with no driver does not render an empty driver card', (tester) async {
      await tester.pumpWidget(host(ride(status: RideStatus.requested)));
      await tester.pumpAndSettle();

      expect(find.byType(CounterpartyCard), findsNothing);
    });
  });

  group('reporting a problem', () {
    testWidgets('is reachable from the receipt', (tester) async {
      await tester.pumpWidget(host(ride(finalFare: const IqdAmount(5000))));
      await tester.pumpAndSettle();

      // Without this the admin dispute queue can only ever be empty.
      expect(find.text('الإبلاغ عن مشكلة'), findsOneWidget);
    });
  });
}
