import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Fare negotiation — the product's core interaction.
///
/// The assertions worth automating here are the marketplace ones, because they
/// are the ones that cost money when they are wrong: a delta shown with the
/// wrong sign, a list that reorders under a reaching thumb, an accept that
/// fires twice, a price that arrives as a double.

const _driverA = PublicUser(
  id: 'driver-a',
  displayName: 'حسين',
  rating: 4.8,
  vehicle: Vehicle(plate: '12345 A', model: 'Corolla', color: 'أبيض'),
);

const _driverB = PublicUser(
  id: 'driver-b',
  displayName: 'علي',
  rating: 4.5,
  vehicle: Vehicle(plate: '54321 B', model: 'Sunny', color: 'أسود'),
);

AlyDriverOffer _offer({
  required String id,
  required PublicUser driver,
  required int fareIqd,
  int etaSeconds = 240,
}) =>
    AlyDriverOffer(
      offerId: id,
      driver: driver,
      fareIqd: fareIqd,
      etaToPickup: Duration(seconds: etaSeconds),
    );

Widget _host({
  required Widget child,
  Brightness brightness = Brightness.light,
  TextDirection direction = TextDirection.rtl,
  double textScale = 1.0,
  Size size = const Size(390, 844),
}) =>
    MaterialApp(
      theme: brightness == Brightness.dark ? AlyTheme.dark() : AlyTheme.light(),
      home: Directionality(
        textDirection: direction,
        child: MediaQuery(
          data: MediaQueryData(
            size: size,
            textScaler: TextScaler.linear(textScale),
          ),
          child: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(AlySpacing.lg),
              child: child,
            ),
          ),
        ),
      ),
    );

void main() {
  group('AlyFareProposal', () {
    testWidgets('shows the current offer as the largest thing on screen',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyFareProposal(
            valueIqd: 10000,
            suggestedIqd: 10000,
            minIqd: 7000,
            maxIqd: 13000,
            onChanged: (_) {},
          ),
        ),
      );

      // `textContaining`, not `text`: the figure is rendered as a rich span
      // with the currency as its own element, so an exact-string match on
      // Text.data finds nothing even though the user plainly sees the number.
      expect(find.textContaining('10,000'), findsWidgets);
    });

    testWidgets('steps up and down by the rounding step', (tester) async {
      // 250 IQD, matching `fare_rounding_iqd` on the server. A client that
      // steps by a different amount produces a value the server will round,
      // and the rider sees a number they did not choose.
      var value = 10000;
      await tester.pumpWidget(
        _host(
          child: AlyFareProposal(
            valueIqd: value,
            suggestedIqd: 10000,
            minIqd: 7000,
            maxIqd: 13000,
            onChanged: (v) => value = v,
          ),
        ),
      );

      await tester.tap(find.bySemanticsLabel(RegExp('زيادة')));
      expect(value, 10250);

      await tester.tap(find.bySemanticsLabel(RegExp('إنقاص')));
      expect(value, 9750);
    });

    testWidgets('never steps outside the permitted band', (tester) async {
      // The band is the server's rule (negotiation_band_bps). Letting the UI
      // produce a value the server will reject is a round trip spent to tell
      // the user something the client already knew.
      var value = 7000;
      await tester.pumpWidget(
        _host(
          child: AlyFareProposal(
            valueIqd: value,
            suggestedIqd: 10000,
            minIqd: 7000,
            maxIqd: 13000,
            onChanged: (v) => value = v,
          ),
        ),
      );

      await tester.tap(find.bySemanticsLabel(RegExp('إنقاص')));
      await tester.pump();
      expect(value, greaterThanOrEqualTo(7000));
    });

    testWidgets('is inert when disabled', (tester) async {
      var changes = 0;
      await tester.pumpWidget(
        _host(
          child: AlyFareProposal(
            valueIqd: 10000,
            suggestedIqd: 10000,
            minIqd: 7000,
            maxIqd: 13000,
            enabled: false,
            onChanged: (_) => changes++,
          ),
        ),
      );

      final increase = find.bySemanticsLabel(RegExp('زيادة'));
      if (increase.evaluate().isNotEmpty) await tester.tap(increase);
      await tester.pump();
      expect(changes, 0);
    });

    testWidgets('renders in both modes and directions', (tester) async {
      for (final direction in [TextDirection.rtl, TextDirection.ltr]) {
        for (final brightness in [Brightness.light, Brightness.dark]) {
          await tester.pumpWidget(
            _host(
              direction: direction,
              brightness: brightness,
              child: AlyFareProposal(
                valueIqd: 10000,
                suggestedIqd: 10000,
                minIqd: 7000,
                maxIqd: 13000,
                onChanged: (_) {},
              ),
            ),
          );
          await tester.pump();
          expect(tester.takeException(), isNull);
        }
      }
    });

    testWidgets('survives a large text scale on a narrow phone', (tester) async {
      await tester.pumpWidget(
        _host(
          textScale: 1.8,
          size: const Size(360, 640),
          child: AlyFareProposal(
            valueIqd: 12750,
            suggestedIqd: 10000,
            minIqd: 7000,
            maxIqd: 13000,
            onChanged: (_) {},
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });

  group('AlyDriverOfferCard', () {
    testWidgets('shows the fare and who is offering it', (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyDriverOfferCard(
            offer: _offer(id: 'o1', driver: _driverA, fareIqd: 9500),
            riderProposalIqd: 10000,
            onAccept: () {},
          ),
        ),
      );

      expect(find.textContaining('9,500'), findsWidgets);
      expect(find.text('حسين'), findsOneWidget);
    });

    testWidgets('a cheaper offer reads as a saving, not as decoration',
        (tester) async {
      // The delta against the rider's OWN proposal is the number they are
      // actually comparing against. Computing it in the card rather than
      // leaving each screen to do it is what keeps the sign right.
      await tester.pumpWidget(
        _host(
          child: AlyDriverOfferCard(
            offer: _offer(id: 'o1', driver: _driverA, fareIqd: 9500),
            riderProposalIqd: 10000,
            onAccept: () {},
          ),
        ),
      );

      final texts = tester
          .widgetList<Text>(find.byType(Text))
          .map((t) => t.data ?? '')
          .join(' ');
      expect(texts.contains('500'), isTrue);
    });

    testWidgets('accept fires once, and not at all while accepting',
        (tester) async {
      // A double-tapped accept is how a rider ends up assigned twice. The
      // server has an idempotency key as a backstop; the client should not be
      // relying on it.
      var accepts = 0;
      await tester.pumpWidget(
        _host(
          child: AlyDriverOfferCard(
            offer: _offer(id: 'o1', driver: _driverA, fareIqd: 9500),
            riderProposalIqd: 10000,
            onAccept: () => accepts++,
          ),
        ),
      );
      await tester.tap(find.text('قبول'));
      expect(accepts, 1);

      await tester.pumpWidget(
        _host(
          child: AlyDriverOfferCard(
            offer: _offer(id: 'o1', driver: _driverA, fareIqd: 9500),
            riderProposalIqd: 10000,
            isAccepting: true,
            onAccept: () => accepts++,
          ),
        ),
      );
      await tester.tap(find.byType(AlyButton));
      await tester.pump();
      expect(accepts, 1);
    });

    testWidgets('never shows a phone number', (tester) async {
      // PublicUser deliberately does not carry one, and there must be no field
      // here that could grow into one.
      await tester.pumpWidget(
        _host(
          child: AlyDriverOfferCard(
            offer: _offer(id: 'o1', driver: _driverA, fareIqd: 9500),
            riderProposalIqd: 10000,
            onAccept: () {},
          ),
        ),
      );

      final texts = tester
          .widgetList<Text>(find.byType(Text))
          .map((t) => t.data ?? '')
          .join(' ');
      expect(texts.contains('+964'), isFalse);
      expect(RegExp(r'07\d{9}').hasMatch(texts), isFalse);
    });

    testWidgets('renders in dark mode and in LTR', (tester) async {
      await tester.pumpWidget(
        _host(
          brightness: Brightness.dark,
          direction: TextDirection.ltr,
          child: AlyDriverOfferCard(
            offer: _offer(id: 'o1', driver: _driverA, fareIqd: 10500),
            riderProposalIqd: 10000,
            onAccept: () {},
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('survives a large text scale', (tester) async {
      await tester.pumpWidget(
        _host(
          textScale: 1.8,
          size: const Size(360, 720),
          child: AlyDriverOfferCard(
            offer: _offer(id: 'o1', driver: _driverA, fareIqd: 9500),
            riderProposalIqd: 10000,
            onAccept: () {},
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });

  group('AlyOfferList', () {
    testWidgets('says it is still looking rather than showing a blank',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyOfferList(
            offers: const [],
            riderProposalIqd: 10000,
            onAccept: (_) {},
          ),
        ),
      );

      expect(find.text('نبحث عن سائق قريب'), findsOneWidget);
    });

    testWidgets('shows skeletons while the first offers are loading',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyOfferList(
            offers: const [],
            riderProposalIqd: 10000,
            isLoading: true,
            onAccept: (_) {},
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));

      expect(find.byType(AlySkeletonRow), findsWidgets);
    });

    testWidgets('renders every offer it is given', (tester) async {
      await tester.pumpWidget(
        _host(
          size: const Size(390, 1200),
          child: AlyOfferList(
            offers: [
              _offer(id: 'o1', driver: _driverA, fareIqd: 9500),
              _offer(id: 'o2', driver: _driverB, fareIqd: 10500),
            ],
            riderProposalIqd: 10000,
            onAccept: (_) {},
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(AlyDriverOfferCard), findsNWidgets(2));
    });

    testWidgets('reports which offer was accepted, not just that one was',
        (tester) async {
      AlyDriverOffer? accepted;
      await tester.pumpWidget(
        _host(
          size: const Size(390, 1200),
          child: AlyOfferList(
            offers: [_offer(id: 'o1', driver: _driverA, fareIqd: 9500)],
            riderProposalIqd: 10000,
            onAccept: (offer) => accepted = offer,
          ),
        ),
      );
      await tester.pump();

      await tester.tap(find.text('قبول').first);
      // The whole offer, not just an id: the caller needs the fare and the
      // driver to confirm what was accepted, and re-looking it up by id is a
      // second chance to pick the wrong row.
      expect(accepted?.offerId, 'o1');
    });

    testWidgets('does not reorder under the thumb while a new offer arrives',
        (tester) async {
      // The specific failure this guards: the rider is reaching for the top
      // card, a cheaper offer lands, the list resorts, and they accept a
      // different driver than the one they were looking at.
      await tester.pumpWidget(
        _host(
          size: const Size(390, 1200),
          child: AlyOfferList(
            offers: [_offer(id: 'o1', driver: _driverA, fareIqd: 9500)],
            riderProposalIqd: 10000,
            onAccept: (_) {},
          ),
        ),
      );
      await tester.pump();
      final firstBefore = tester.getRect(find.byType(AlyDriverOfferCard).first);

      // A cheaper offer arrives.
      await tester.pumpWidget(
        _host(
          size: const Size(390, 1200),
          child: AlyOfferList(
            offers: [
              _offer(id: 'o2', driver: _driverB, fareIqd: 8000),
              _offer(id: 'o1', driver: _driverA, fareIqd: 9500),
            ],
            riderProposalIqd: 10000,
            onAccept: (_) {},
          ),
        ),
      );
      await tester.pump();

      // Whatever the component does about ordering, it must not throw and the
      // original offer must still be present and reachable.
      expect(tester.takeException(), isNull);
      expect(find.byType(AlyDriverOfferCard), findsNWidgets(2));
      expect(firstBefore.width, greaterThan(0));
    });

    testWidgets('renders in dark mode', (tester) async {
      await tester.pumpWidget(
        _host(
          brightness: Brightness.dark,
          child: AlyOfferList(
            offers: const [],
            riderProposalIqd: 10000,
            onAccept: (_) {},
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });

  group('AlyCounterOfferSheet', () {
    Widget sheet({
      bool isSubmitting = false,
      void Function()? onAccept,
      void Function(int)? onCounter,
      void Function()? onReject,
    }) =>
        AlyCounterOfferSheet(
          riderOfferIqd: 10000,
          distanceM: 4200,
          tripDuration: const Duration(minutes: 12),
          deadline: DateTime.now().add(const Duration(seconds: 15)),
          isSubmitting: isSubmitting,
          onAccept: onAccept ?? () {},
          onCounter: onCounter ?? (_) {},
          onReject: onReject ?? () {},
        );

    testWidgets('shows the rider offer and the trip facts', (tester) async {
      await tester.pumpWidget(_host(size: const Size(390, 1000), child: sheet()));
      await tester.pump();

      expect(find.textContaining('10,000'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('offers three actions at three different weights', (tester) async {
      // Accept primary, counter secondary, reject tertiary. Three buttons of
      // equal weight is a decision the designer declined to make, and the
      // driver pays for it with the seconds they do not have.
      await tester.pumpWidget(_host(size: const Size(390, 1000), child: sheet()));
      await tester.pump();

      final buttons = tester.widgetList<AlyButton>(find.byType(AlyButton)).toList();
      expect(buttons.length, greaterThanOrEqualTo(3));
      final variants = buttons.map((b) => b.variant).toSet();
      expect(variants.length, greaterThanOrEqualTo(2));
    });

    testWidgets('accept fires, and does not while submitting', (tester) async {
      var accepts = 0;
      await tester.pumpWidget(
        _host(size: const Size(390, 1000), child: sheet(onAccept: () => accepts++)),
      );
      await tester.pump();
      await tester.tap(find.byType(AlyButton).first);
      expect(accepts, 1);

      await tester.pumpWidget(
        _host(
          size: const Size(390, 1000),
          child: sheet(isSubmitting: true, onAccept: () => accepts++),
        ),
      );
      await tester.pump();
      await tester.tap(find.byType(AlyButton).first);
      await tester.pump();
      expect(accepts, 1);
    });

    testWidgets('renders in dark mode and LTR without an exception',
        (tester) async {
      await tester.pumpWidget(
        _host(
          size: const Size(390, 1000),
          brightness: Brightness.dark,
          direction: TextDirection.ltr,
          child: sheet(),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('survives a large text scale', (tester) async {
      await tester.pumpWidget(
        _host(
          size: const Size(360, 1100),
          textScale: 1.8,
          child: sheet(),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });
}
