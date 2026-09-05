import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The rider's home, in every state it can be in.
///
/// The states worth testing are the ones a live server makes hard to reach:
/// location refused, offline, a closed zone, a failed request. Those are exactly
/// the states the old rider screens had no coverage for, because they fetched
/// their own data and there was no way to put them into a failure.
///
/// The map is injected, so all of this runs with no platform view and no API
/// key.

const _driver = PublicUser(
  id: 'driver-1',
  displayName: 'حسين',
  rating: 4.8,
  vehicle: Vehicle(plate: '12345 A', model: 'Corolla', color: 'أبيض'),
);

const _estimate = FareEstimate(
  estimatedFareIqd: IqdAmount(7500),
  distanceM: 4200,
  durationS: 720,
  breakdown: FareBreakdown(
    baseIqd: IqdAmount(2000),
    distanceIqd: IqdAmount(2100),
    timeIqd: IqdAmount(600),
    minimumAppliedIqd: IqdAmount.zero,
    roundingIqd: IqdAmount(250),
  ),
);

final _ride = Ride(
  id: 'ride-1',
  status: RideStatus.accepted,
  pickup: const LatLng(lat: 33.3061, lng: 44.4213),
  dropoff: const LatLng(lat: 33.2989, lng: 44.4361),
  pickupAddress: 'ساحة التحرير',
  dropoffAddress: 'الكرادة',
  estimatedFareIqd: const IqdAmount(7500),
  estimatedDistanceM: 4200,
  estimatedDurationS: 720,
  requestedAt: DateTime.utc(2026, 3, 4, 6),
  driver: _driver,
);

/// A stand-in for the real map. A coloured box is enough: the screen must not
/// care what is behind it.
const _map = ColoredBox(color: Color(0xFFBFD8C2), child: SizedBox.expand());

/// Pump the screen at a REAL surface size.
///
/// Setting MediaQuery alone would make the widget believe the screen is 390x844
/// while the test surface stayed at Flutter's default 800x600. Layout then reads
/// one size and `tester.getSize` reports the other, so every size assertion
/// silently compares two different screens - which is how a sheet capped at 55%
/// first measured as 77% here.
///
/// Sizing and pumping in one call is what makes that impossible to get wrong
/// again: there is no way to do one without the other.
Future<void> _pump(
  WidgetTester tester, {
  required RiderHomeState state,
  Brightness brightness = Brightness.light,
  TextDirection direction = TextDirection.rtl,
  double textScale = 1.0,
  Size size = const Size(390, 844),
  VoidCallback? onSearch,
  VoidCallback? onRequest,
  VoidCallback? onCancel,
  VoidCallback? onRetry,
  VoidCallback? onEnableLocation,
  VoidCallback? onMenu,
  ValueChanged<SavedPlace>? onPickRecent,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      theme: brightness == Brightness.dark ? AlyTheme.dark() : AlyTheme.light(),
      home: Directionality(
        textDirection: direction,
        child: MediaQuery(
          data: MediaQueryData(
            size: size,
            textScaler: TextScaler.linear(textScale),
          ),
          child: AlyRiderHome(
            state: state,
            mapLayer: _map,
            onSearchDestination: onSearch ?? () {},
            onRequestRide: onRequest ?? () {},
            onCancel: onCancel ?? () {},
            onRetry: onRetry ?? () {},
            onEnableLocation: onEnableLocation ?? () {},
            onOpenMenu: onMenu ?? () {},
            onPickRecent: onPickRecent,
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  group('the map is the screen', () {
    testWidgets('renders behind everything, in every stage', (tester) async {
      // The map answers "where am I" without being asked. A stage that covers
      // it is a stage where the rider cannot see the thing they opened the app
      // for.
      for (final stage in RiderHomeStage.values) {
        await _pump(tester, state: RiderHomeState(stage: stage));
        expect(find.byType(ColoredBox), findsWidgets, reason: '$stage');
        expect(tester.takeException(), isNull, reason: '$stage');
      }
    });

    testWidgets('the sheet leaves the map visible however long the content is',
        (tester) async {
      // Measured, not asserted in a comment. A sheet that grows to fill the
      // screen during a trip is the failure this constraint exists to stop.
      await _pump(
        tester,
        state: RiderHomeState(
          recentPlaces: List.generate(
            10,
            (i) => SavedPlace(label: 'مكان $i', address: 'عنوان طويل جداً رقم $i'),
          ),
        ),
      );

      final screen = tester.getSize(find.byType(AlyRiderHome));
      final sheetTop = tester.getRect(find.byType(SingleChildScrollView)).top;
      expect(sheetTop, greaterThan(screen.height * 0.4));
    });
  });

  group('idle - the only thing the rider came to do', () {
    testWidgets('asks where to, and nothing else', (tester) async {
      await _pump(tester, state: const RiderHomeState());

      expect(find.text('إلى أين؟'), findsOneWidget);
      // No trip history, no wallet, no promotions. One task.
      expect(find.textContaining('رحلاتي'), findsNothing);
    });

    testWidgets('the destination field opens the search screen, not a keyboard',
        (tester) async {
      // A live field here would put a keyboard over the map to do a job the
      // full screen does better.
      var searches = 0;
      await _pump(tester, state: const RiderHomeState(), onSearch: () => searches++);

      await tester.tap(find.bySemanticsLabel('اختيار الوجهة'));
      expect(searches, 1);
    });

    testWidgets('shows recent places, capped at three', (tester) async {
      // A shortcut, not a history screen: a rider scanning ten rows is slower
      // than one typing.
      await _pump(
        tester,
        state: RiderHomeState(
          recentPlaces: List.generate(
            8,
            (i) => SavedPlace(label: 'وجهة $i', address: 'عنوان $i'),
          ),
        ),
      );

      expect(find.text('وجهة 0'), findsOneWidget);
      expect(find.text('وجهة 2'), findsOneWidget);
      expect(find.text('وجهة 3'), findsNothing);
    });

    testWidgets('picking a recent place reports which one', (tester) async {
      SavedPlace? picked;
      await _pump(
        tester,
        state: const RiderHomeState(
          recentPlaces: [SavedPlace(label: 'البيت', address: 'الكرادة')],
        ),
        onPickRecent: (p) => picked = p,
      );

      await tester.tap(find.text('البيت'));
      expect(picked?.label, 'البيت');
    });
  });

  group('location refused is a choice, not an error', () {
    testWidgets('explains what it costs and offers to fix it', (tester) async {
      // Dressing a permission the rider deliberately withheld as an error tells
      // them they did something wrong.
      await _pump(tester, state: const RiderHomeState(locationDenied: true));

      expect(find.text('لا نعرف مكانك'), findsOneWidget);
      expect(find.text('تفعيل الموقع'), findsOneWidget);
      // And the screen still works: destination entry is still there.
      expect(find.bySemanticsLabel('اختيار الوجهة'), findsOneWidget);
    });

    testWidgets('the enable action fires', (tester) async {
      var enabled = 0;
      await _pump(
        tester,
        state: const RiderHomeState(locationDenied: true),
        onEnableLocation: () => enabled++,
      );

      await tester.tap(find.text('تفعيل الموقع'));
      expect(enabled, 1);
    });
  });

  group('a closed zone outranks everything', () {
    testWidgets('refuses the request rather than pricing a trip nobody can serve',
        (tester) async {
      await _pump(
        tester,
        state: const RiderHomeState(
          // Deliberately contradictory: a fare and a destination are set, and
          // the zone still wins. Letting the rider request here would produce a
          // ride no driver can take.
          stage: RiderHomeStage.readyToRequest,
          zoneAvailable: false,
          dropoffAddress: 'المنصور',
          estimate: _estimate,
        ),
      );

      expect(find.textContaining('لا يعمل في هذه المنطقة'), findsOneWidget);
      expect(find.text('اطلب الرحلة'), findsNothing);
    });
  });

  group('estimating', () {
    testWidgets('shows skeletons rather than a spinner or a blank', (tester) async {
      // The shape of what is coming is itself information, and it stops the
      // sheet resizing when the fare lands.
      await _pump(tester, state: const RiderHomeState(stage: RiderHomeStage.estimating));
      await tester.pump(const Duration(milliseconds: 200));

      expect(find.byType(AlySkeleton), findsWidgets);
    });
  });

  group('ready to request', () {
    testWidgets('shows the route, the fare, and one obvious action', (tester) async {
      await _pump(
        tester,
        state: const RiderHomeState(
          stage: RiderHomeStage.readyToRequest,
          pickupAddress: 'ساحة التحرير',
          dropoffAddress: 'الكرادة',
          estimate: _estimate,
        ),
      );

      expect(find.text('ساحة التحرير'), findsOneWidget);
      expect(find.text('الكرادة'), findsOneWidget);
      expect(find.textContaining('7,500'), findsWidgets);
      expect(find.text('اطلب الرحلة'), findsOneWidget);
    });

    testWidgets('calls the fare an estimate rather than implying a promise',
        (tester) async {
      await _pump(
        tester,
        state: const RiderHomeState(
          stage: RiderHomeStage.readyToRequest,
          dropoffAddress: 'الكرادة',
          estimate: _estimate,
        ),
      );

      expect(find.textContaining('قد يختلف'), findsOneWidget);
    });

    testWidgets('the request action fires exactly once per tap', (tester) async {
      var requests = 0;
      await _pump(
        tester,
        state: const RiderHomeState(
          stage: RiderHomeStage.readyToRequest,
          dropoffAddress: 'الكرادة',
          estimate: _estimate,
        ),
        onRequest: () => requests++,
      );

      await tester.tap(find.text('اطلب الرحلة'));
      expect(requests, 1);
    });
  });

  group('searching', () {
    testWidgets('sets an expectation instead of leaving the rider guessing',
        (tester) async {
      await _pump(tester, state: const RiderHomeState(stage: RiderHomeStage.searching));

      expect(find.textContaining('نبحث عن سائق'), findsOneWidget);
      expect(find.textContaining('أقل من دقيقة'), findsOneWidget);
    });

    testWidgets('cancel is reachable but not the loudest thing on screen',
        (tester) async {
      // Cancelling is legitimate. It is not what the rider came to do, and a
      // prominent cancel beside a wait invites a tap that was never intended.
      var cancels = 0;
      await _pump(
        tester,
        state: const RiderHomeState(stage: RiderHomeStage.searching),
        onCancel: () => cancels++,
      );

      final button = tester.widget<AlyButton>(find.byType(AlyButton));
      expect(button.variant, AlyButtonVariant.tertiary);

      await tester.tap(find.text('إلغاء الطلب'));
      expect(cancels, 1);
    });
  });

  group('failure', () {
    testWidgets('says what happened and offers a way out', (tester) async {
      // Never a status code, never an exception. Every message answers
      // "what now?".
      await _pump(
        tester,
        state: const RiderHomeState(
          stage: RiderHomeStage.readyToRequest,
          errorMessage: 'انقطع الاتصال قبل إرسال الطلب. حاول مرة أخرى.',
        ),
      );

      expect(find.textContaining('انقطع الاتصال'), findsOneWidget);
    });

    testWidgets('an offline banner appears without hiding the map', (tester) async {
      await _pump(tester, state: const RiderHomeState(offline: true));

      expect(find.byType(AlyOfflineBanner), findsOneWidget);
      expect(find.byType(ColoredBox), findsWidgets);
    });
  });

  group('on trip', () {
    testWidgets('the sheet becomes the trip', (tester) async {
      await _pump(
        tester,
        state: RiderHomeState(
          stage: RiderHomeStage.onTrip,
          ride: _ride,
          driver: _driver,
        ),
      );

      expect(find.text('حسين'), findsOneWidget);
      expect(find.text('ساحة التحرير'), findsOneWidget);
      // Never a raw enum.
      expect(find.textContaining('ACCEPTED'), findsNothing);
    });
  });

  group('it holds up', () {
    testWidgets('in dark mode and in English', (tester) async {
      for (final stage in RiderHomeStage.values) {
        await _pump(
          tester,
          state: RiderHomeState(stage: stage, estimate: _estimate, ride: _ride),
          brightness: Brightness.dark,
          direction: TextDirection.ltr,
        );
        expect(tester.takeException(), isNull, reason: '$stage');
      }
    });

    testWidgets('at 1.8x text on a small phone', (tester) async {
      for (final stage in RiderHomeStage.values) {
        await _pump(
          tester,
          state: RiderHomeState(
            stage: stage,
            estimate: _estimate,
            ride: _ride,
            pickupAddress: 'ساحة التحرير في وسط بغداد',
            dropoffAddress: 'شارع الكرادة داخل قرب الجامعة',
            locationDenied: true,
          ),
          textScale: 1.8,
          size: const Size(360, 640),
        );
        expect(tester.takeException(), isNull, reason: '$stage');
      }
    });

    testWidgets('in landscape', (tester) async {
      await _pump(
        tester,
        state: const RiderHomeState(
          stage: RiderHomeStage.readyToRequest,
          estimate: _estimate,
          dropoffAddress: 'الكرادة',
        ),
        size: const Size(844, 390),
      );
      expect(tester.takeException(), isNull);
    });
  });
}
