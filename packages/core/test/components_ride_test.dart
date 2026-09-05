import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The ride components, asserted rather than eyeballed.
///
/// These tests are aimed at the four failures that a screenshot review cannot
/// catch and that a Baghdad user hits first:
///
///   - a fare that renders as a blank or a zero because the ride has not
///     settled yet;
///   - a raw `RideStatus` enum name reaching a screen;
///   - a layout that is right in Arabic and mirrored wrongly in English;
///   - text at the accessibility scale overflowing a card.
///
/// Every widget is exercised in both directions, both brightnesses, and at
/// 1.8x type on a 360pt-wide phone, because those are the four axes that ship
/// broken.

Widget _host({
  required Widget child,
  Brightness brightness = Brightness.light,
  TextDirection direction = TextDirection.rtl,
  double textScale = 1.0,
}) =>
    MaterialApp(
      theme: brightness == Brightness.dark ? AlyTheme.dark() : AlyTheme.light(),
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(textScale)),
          child: Directionality(
            textDirection: direction,
            child: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(AlySpacing.gutter),
                child: Align(alignment: Alignment.topCenter, child: child),
              ),
            ),
          ),
        ),
      ),
    );

/// Renders on a real phone's logical size at the accessibility text scale.
///
/// 1080x2400 at dpr 3 is 360x800pt — the narrowest Android still in wide use in
/// Iraq. An overflow at 1.8x here is a `FlutterError` and `takeException`
/// surfaces it; the default 800x600 test window is wide enough to hide most of
/// them.
Future<void> _expectSurvivesLargeText(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(_host(child: child, textScale: 1.8));
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
}

/// Renders in both directions and both brightnesses, asserting nothing throws.
Future<void> _expectSurvivesEveryMode(WidgetTester tester, Widget child) async {
  for (final direction in [TextDirection.rtl, TextDirection.ltr]) {
    for (final brightness in [Brightness.light, Brightness.dark]) {
      await tester.pumpWidget(
        _host(child: child, direction: direction, brightness: brightness),
      );
      await tester.pumpAndSettle();
      expect(
        tester.takeException(),
        isNull,
        reason: 'threw in $direction / $brightness',
      );
    }
  }
}

const String _pickup = 'شارع أبو نؤاس، قرب جسر الجمهورية، بغداد';
const String _dropoff =
    'مطار بغداد الدولي، صالة المغادرة الدولية، البوابة الرابعة، بغداد';

Ride _ride({
  RideStatus status = RideStatus.completed,
  int? finalFareIqd = 12500,
  String? pickupAddress = _pickup,
  String? dropoffAddress = _dropoff,
  DateTime? acceptedAt,
  DateTime? driverArrivedAt,
  DateTime? startedAt,
  DateTime? completedAt,
  DateTime? cancelledAt,
}) =>
    Ride(
      id: '9f1c3a2e-0000-4000-8000-000000000001',
      status: status,
      pickup: const LatLng(lat: 33.3152, lng: 44.3661),
      dropoff: const LatLng(lat: 33.2625, lng: 44.2346),
      pickupAddress: pickupAddress,
      dropoffAddress: dropoffAddress,
      estimatedFareIqd: const IqdAmount(10000),
      finalFareIqd: finalFareIqd == null ? null : IqdAmount(finalFareIqd),
      estimatedDistanceM: 18400,
      estimatedDurationS: 1980,
      requestedAt: DateTime.utc(2026, 3, 4, 6, 15),
      acceptedAt: acceptedAt,
      driverArrivedAt: driverArrivedAt,
      startedAt: startedAt,
      completedAt: completedAt,
      cancelledAt: cancelledAt,
    );

const PublicUser _driver = PublicUser(
  id: 'd-1',
  displayName: 'حيدر عبد الأمير',
  rating: 4.6,
  vehicle: Vehicle(plate: '24 A 71835', model: 'تويوتا كورولا', color: 'أبيض'),
);

/// Every string currently painted, joined. Used to assert that something is
/// absent from the whole subtree rather than from one widget.
String _allText(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((text) => text.data ?? '')
    .join(' | ');

void main() {
  setUpAll(() async {
    // `formatDateTimeAr` uses `DateFormat` with a non-`en_US` locale, which a
    // real app initialises through `GlobalMaterialLocalizations`. A bare
    // `MaterialApp` in a test does not, so the test does it explicitly.
    await initializeDateFormatting('ar');
    await initializeDateFormatting('en');
  });

  group('AlyRouteSummary', () {
    testWidgets('shows both addresses and truncates rather than overflowing',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: const SizedBox(
            width: 280,
            child: AlyRouteSummary(
              pickupAddress: _pickup,
              dropoffAddress: _dropoff,
            ),
          ),
        ),
      );

      expect(find.text(_pickup), findsOneWidget);
      expect(find.text(_dropoff), findsOneWidget);
      // 280pt cannot hold either address. Both must ellipsize on one line; a
      // wrap here is what pushes the fare off a history row.
      for (final address in [_pickup, _dropoff]) {
        final widget = tester.widget<Text>(find.text(address));
        expect(widget.maxLines, 1);
        expect(widget.overflow, TextOverflow.ellipsis);
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('puts the connector rail on the START side in both languages',
        (tester) async {
      // The rail is 16pt wide with a 12pt gap before the text.
      const railInset = AlySpacing.lg + AlySpacing.md;
      const summary = AlyRouteSummary(
        pickupAddress: 'الكرادة',
        dropoffAddress: 'المنصور',
      );

      await tester.pumpWidget(_host(child: summary));
      final rtlBox = tester.getRect(find.byType(AlyRouteSummary));
      final rtlText = tester.getRect(find.text('الكرادة'));
      // Arabic: rail on the right, so the text stops short of the right edge.
      expect(rtlBox.right - rtlText.right, moreOrLessEquals(railInset, epsilon: 1));

      await tester.pumpWidget(
        _host(child: summary, direction: TextDirection.ltr),
      );
      final ltrBox = tester.getRect(find.byType(AlyRouteSummary));
      final ltrText = tester.getRect(find.text('الكرادة'));
      // English: the same widget, mirrored, with no second code path.
      expect(ltrText.left - ltrBox.left, moreOrLessEquals(railInset, epsilon: 1));
    });

    testWidgets('a dropped pin gets words, never coordinates', (tester) async {
      await tester.pumpWidget(
        _host(
          child: const AlyRouteSummary(
            pickupAddress: null,
            dropoffAddress: null,
          ),
        ),
      );

      expect(find.text('موقع محدد على الخريطة'), findsNWidgets(2));
      // Nobody recognises their own street from a decimal degree, and
      // CLAUDE.md §9 treats an exact coordinate as something to keep out of
      // sight.
      expect(_allText(tester).contains('33.3'), isFalse);
    });

    testWidgets('forRide reads the ride, not a hand-copied pair',
        (tester) async {
      await tester.pumpWidget(_host(child: AlyRouteSummary.forRide(_ride())));
      expect(find.text(_pickup), findsOneWidget);
      expect(find.text(_dropoff), findsOneWidget);
    });

    testWidgets('renders in both directions and both modes', (tester) async {
      await _expectSurvivesEveryMode(
        tester,
        const AlyRouteSummary(pickupAddress: _pickup, dropoffAddress: _dropoff),
      );
    });

    testWidgets('survives 1.8x text', (tester) async {
      await _expectSurvivesLargeText(
        tester,
        const AlyRouteSummary(
          pickupAddress: _pickup,
          dropoffAddress: _dropoff,
          maxLines: 2,
        ),
      );
    });
  });

  group('AlyRideCard', () {
    testWidgets('a settled ride shows the fare it actually charged',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyRideCard(
            ride: _ride(completedAt: DateTime.utc(2026, 3, 4, 6, 55)),
            onTap: () {},
          ),
        ),
      );

      expect(find.text('12,500 د.ع'), findsOneWidget);
      expect(find.text('مكتملة'), findsOneWidget);
      // The estimate must not appear next to a settled fare — two numbers on a
      // receipt is a support call.
      expect(_allText(tester).contains('10,000'), isFalse);
    });

    testWidgets('an unsettled ride labels the estimate and never shows zero',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyRideCard(
            ride: _ride(
              status: RideStatus.inProgress,
              finalFareIqd: null,
              acceptedAt: DateTime.utc(2026, 3, 4, 6, 20),
            ),
            onTap: () {},
          ),
        ),
      );

      expect(find.text('تقديري'), findsOneWidget);
      expect(find.text('10,000 د.ع'), findsOneWidget);
      expect(find.text('الرحلة جارية'), findsOneWidget);
      // The two ways this goes wrong: a blank where the fare should be, or a
      // zero that a rider reads as a fact.
      // An EXACT match, not a substring. `contains` was true for the perfectly
      // correct '10,000 د.ع', because that string ends in '0 د.ع' - the test
      // failed on the value it was written to protect.
      expect(find.text('0 د.ع'), findsNothing);
    });

    testWidgets('a cancelled ride says there is no fare rather than showing one',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyRideCard(
            ride: _ride(
              status: RideStatus.cancelledByRider,
              finalFareIqd: null,
              cancelledAt: DateTime.utc(2026, 3, 4, 6, 22),
            ),
            onTap: () {},
          ),
        ),
      );

      expect(find.text('بدون أجرة'), findsOneWidget);
      expect(find.text('ألغيتها'), findsOneWidget);
      // Showing the estimate for a ride nobody took would read as a charge.
      expect(_allText(tester).contains('د.ع'), isFalse);
    });

    testWidgets('taps fire, and do not when the card is inert', (tester) async {
      var taps = 0;
      await tester.pumpWidget(
        _host(child: AlyRideCard(ride: _ride(), onTap: () => taps++)),
      );

      await tester.tap(find.byType(AlyRideCard));
      await tester.pumpAndSettle();
      expect(taps, 1);

      await tester.pumpWidget(
        _host(child: AlyRideCard(ride: _ride(), onTap: null)),
      );
      await tester.tap(find.byType(AlyRideCard));
      await tester.pumpAndSettle();
      expect(taps, 1, reason: 'a null onTap must not deliver a press');
      expect(tester.takeException(), isNull);
    });

    testWidgets('announces itself as a button only when it is one',
        (tester) async {
      final handle = tester.ensureSemantics();

      await tester.pumpWidget(
        _host(child: AlyRideCard(ride: _ride(), onTap: () {})),
      );
      expect(
        tester.getSemantics(find.byType(AlyRideCard)).flagsCollection.isButton,
        isTrue,
      );

      await tester.pumpWidget(
        _host(child: AlyRideCard(ride: _ride(), onTap: null)),
      );
      expect(
        tester.getSemantics(find.byType(AlyRideCard)).flagsCollection.isButton,
        isFalse,
        reason: 'an inert card must not promise a screen reader an action',
      );

      handle.dispose();
    });

    testWidgets('renders in both directions and both modes', (tester) async {
      await _expectSurvivesEveryMode(
        tester,
        AlyRideCard(ride: _ride(), onTap: () {}),
      );
    });

    testWidgets('survives 1.8x text with a long status and a long address',
        (tester) async {
      await _expectSurvivesLargeText(
        tester,
        AlyRideCard(
          ride: _ride(
            status: RideStatus.cancelledInTrip,
            finalFareIqd: null,
            cancelledAt: DateTime.utc(2026, 3, 4, 6, 40),
          ),
          onTap: () {},
        ),
      );
    });
  });

  group('AlyTripStatusTimeline', () {
    testWidgets('renders the four steps in Arabic, never an enum name',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyTripStatusTimeline.forRide(
            _ride(
              status: RideStatus.inProgress,
              finalFareIqd: null,
              acceptedAt: DateTime.utc(2026, 3, 4, 6, 20),
              driverArrivedAt: DateTime.utc(2026, 3, 4, 6, 27),
              startedAt: DateTime.utc(2026, 3, 4, 6, 30),
            ),
          ),
        ),
      );

      expect(find.text('السائق في الطريق'), findsOneWidget);
      expect(find.text('وصل السائق'), findsOneWidget);
      expect(find.text('الرحلة جارية'), findsOneWidget);
      expect(find.text('مكتملة'), findsOneWidget);

      final painted = _allText(tester);
      for (final wire in ['IN_PROGRESS', 'DRIVER_ARRIVED', 'RideStatus']) {
        expect(painted.contains(wire), isFalse, reason: '$wire reached a user');
      }
    });

    testWidgets('a cancellation terminates the timeline instead of leaving a gap',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyTripStatusTimeline.forRide(
            _ride(
              status: RideStatus.cancelledByDriver,
              finalFareIqd: null,
              acceptedAt: DateTime.utc(2026, 3, 4, 6, 20),
              cancelledAt: DateTime.utc(2026, 3, 4, 6, 26),
            ),
          ),
        ),
      );

      expect(find.text('السائق في الطريق'), findsOneWidget);
      expect(find.text('ألغاها السائق'), findsOneWidget);
      // The steps that will never happen are gone, not greyed out: a rider
      // staring at a pending "الرحلة جارية" is waiting for nothing.
      expect(find.text('الرحلة جارية'), findsNothing);
      expect(find.text('مكتملة'), findsNothing);
      expect(find.byIcon(Icons.close_rounded), findsOneWidget);
    });

    testWidgets('a ride that never found a driver is one terminal step',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: const AlyTripStatusTimeline(status: RideStatus.noDriversFound),
        ),
      );

      expect(find.text('لا يوجد سائق متاح'), findsOneWidget);
      expect(find.text('السائق في الطريق'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a completed ride marks every step done', (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyTripStatusTimeline.forRide(
            _ride(
              acceptedAt: DateTime.utc(2026, 3, 4, 6, 20),
              driverArrivedAt: DateTime.utc(2026, 3, 4, 6, 27),
              startedAt: DateTime.utc(2026, 3, 4, 6, 30),
              completedAt: DateTime.utc(2026, 3, 4, 6, 55),
            ),
          ),
        ),
      );

      // Three checks behind, and the head of the timeline on the last step.
      expect(find.byIcon(Icons.check_rounded), findsNWidgets(3));
      expect(find.byIcon(Icons.circle), findsOneWidget);
      expect(find.byIcon(Icons.close_rounded), findsNothing);
    });

    testWidgets('renders in both directions and both modes', (tester) async {
      await _expectSurvivesEveryMode(
        tester,
        const AlyTripStatusTimeline(status: RideStatus.driverArrived),
      );
    });

    testWidgets('survives 1.8x text', (tester) async {
      await _expectSurvivesLargeText(
        tester,
        AlyTripStatusTimeline.forRide(
          _ride(
            status: RideStatus.cancelledInTrip,
            finalFareIqd: null,
            acceptedAt: DateTime.utc(2026, 3, 4, 6, 20),
            driverArrivedAt: DateTime.utc(2026, 3, 4, 6, 27),
            startedAt: DateTime.utc(2026, 3, 4, 6, 30),
            cancelledAt: DateTime.utc(2026, 3, 4, 6, 44),
          ),
        ),
      );
    });
  });

  group('AlyDriverCard', () {
    testWidgets('shows name, rating, vehicle and plate', (tester) async {
      await tester.pumpWidget(_host(child: const AlyDriverCard(driver: _driver)));

      expect(find.text('حيدر عبد الأمير'), findsOneWidget);
      expect(find.text('24 A 71835'), findsOneWidget);
      expect(find.text('تويوتا كورولا · أبيض'), findsOneWidget);
      expect(find.text('4.6'), findsOneWidget);
    });

    testWidgets('carries no phone number anywhere in the subtree',
        (tester) async {
      await tester.pumpWidget(_host(child: const AlyDriverCard(driver: _driver)));

      // ACCEPTANCE_CHECKLIST check 5, asserted at the pixel level rather than
      // trusted to the model: no E.164, no local 07 form, no dial affordance.
      final painted = _allText(tester);
      expect(painted.contains('+964'), isFalse);
      expect(RegExp(r'\b07\d{8}\b').hasMatch(painted), isFalse);
      expect(find.byIcon(Icons.phone), findsNothing);
      expect(find.byIcon(Icons.call), findsNothing);
    });

    testWidgets('a driver with no vehicle on file still renders', (tester) async {
      await tester.pumpWidget(
        _host(
          child: const AlyDriverCard(
            driver: PublicUser(id: 'd-2', displayName: 'مصطفى'),
          ),
        ),
      );

      expect(find.text('مصطفى'), findsOneWidget);
      expect(find.byType(AlyRatingStars), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('renders in both directions and both modes', (tester) async {
      await _expectSurvivesEveryMode(
        tester,
        const AlyDriverCard(driver: _driver),
      );
    });

    testWidgets('survives 1.8x text', (tester) async {
      await _expectSurvivesLargeText(
        tester,
        const AlyDriverCard(driver: _driver),
      );
    });
  });

  group('AlyRatingStars', () {
    testWidgets('read-only mode shows the number beside the stars',
        (tester) async {
      await tester.pumpWidget(_host(child: const AlyRatingStars(value: 4.6)));

      expect(find.text('4.6'), findsOneWidget);
      expect(find.byIcon(Icons.star_rounded), findsNWidgets(4));
      expect(find.byIcon(Icons.star_half_rounded), findsOneWidget);
    });

    testWidgets('read-only mode is one semantic label, not five buttons',
        (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(child: const AlyRatingStars(value: 4.6)));

      expect(find.bySemanticsLabel('التقييم 4.6 من 5'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('input mode reports the star that was tapped', (tester) async {
      var given = 0;
      await tester.pumpWidget(
        _host(
          child: AlyRatingStars.input(value: 0, onChanged: (v) => given = v),
        ),
      );

      await tester.tap(find.byIcon(Icons.star_outline_rounded).at(2));
      await tester.pumpAndSettle();
      expect(given, 3);

      await tester.tap(find.byIcon(Icons.star_outline_rounded).at(4));
      await tester.pumpAndSettle();
      expect(given, 5);
    });

    testWidgets('input mode delivers nothing when disabled', (tester) async {
      const given = 0;
      await tester.pumpWidget(
        _host(child: const AlyRatingStars.input(value: 0, onChanged: null)),
      );

      await tester.tap(find.byIcon(Icons.star_outline_rounded).at(2));
      await tester.pumpAndSettle();
      expect(given, 0);
      expect(tester.takeException(), isNull);
    });

    testWidgets('every input star is its own labelled target', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(
        _host(child: AlyRatingStars.input(value: 3, onChanged: (_) {})),
      );

      // Arabic counts in three forms; a screen reader says exactly what it is
      // given, so "1 نجوم" would be wrong out loud.
      expect(find.bySemanticsLabel('نجمة واحدة'), findsOneWidget);
      expect(find.bySemanticsLabel('نجمتان'), findsOneWidget);
      expect(find.bySemanticsLabel('5 نجوم'), findsOneWidget);

      // The tap target, not the glyph, is what a thumb has to hit.
      for (var i = 0; i < 5; i++) {
        final size = tester.getSize(find.byType(GestureDetector).at(i));
        expect(size.width, greaterThanOrEqualTo(AlySpacing.tapTargetSmall));
        expect(size.height, greaterThanOrEqualTo(AlySpacing.tapTargetSmall));
      }

      handle.dispose();
    });

    testWidgets('renders in both directions and both modes', (tester) async {
      await _expectSurvivesEveryMode(
        tester,
        AlyRatingStars.input(value: 4, onChanged: (_) {}),
      );
      await _expectSurvivesEveryMode(tester, const AlyRatingStars(value: 3.2));
    });

    testWidgets('survives 1.8x text', (tester) async {
      await _expectSurvivesLargeText(
        tester,
        Column(
          children: [
            const AlyRatingStars(value: 4.6),
            const SizedBox(height: AlySpacing.lg),
            AlyRatingStars.input(value: 2, onChanged: (_) {}),
          ],
        ),
      );
    });
  });
}
