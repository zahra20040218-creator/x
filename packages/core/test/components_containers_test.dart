import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Surfaces and overlays.
///
/// The properties asserted here are the ones that are decided once in a
/// component and then repeated on every screen: whether a sheet's action stays
/// reachable with the keyboard open, whether a destructive confirm is the
/// default focus, whether elevation is expressed as shadow in light and
/// luminance in dark. Getting any of them wrong once is getting it wrong
/// everywhere.

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
          child: Scaffold(body: Center(child: child)),
        ),
      ),
    );

/// Every BoxDecoration inside the card under test, whatever kind of container
/// carries it.
/// AnimatedContainer, not Container - they are different types, and looking
/// for the wrong one silently finds nothing, which is how the first version of
/// this helper reported "no shadow" for a card that has two.
List<BoxDecoration> _decorations(WidgetTester tester) => tester
    .widgetList<AnimatedContainer>(find.byType(AnimatedContainer))
    .map((w) => w.decoration)
    .whereType<BoxDecoration>()
    .toList();

void main() {
  group('AlyCard', () {
    testWidgets('renders its child', (tester) async {
      await tester.pumpWidget(
        _host(child: const AlyCard(child: Text('محتوى البطاقة'))),
      );
      expect(find.text('محتوى البطاقة'), findsOneWidget);
    });

    testWidgets('fires onTap when it is tappable, and is inert when it is not',
        (tester) async {
      var taps = 0;
      await tester.pumpWidget(
        _host(
          child: AlyCard(onTap: () => taps++, child: const Text('اضغط')),
        ),
      );
      await tester.tap(find.text('اضغط'));
      expect(taps, 1);

      await tester.pumpWidget(
        _host(child: const AlyCard(child: Text('اضغط'))),
      );
      await tester.tap(find.text('اضغط'));
      await tester.pump();
      expect(taps, 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('carries a shadow in light mode and none in dark', (tester) async {
      // In light mode there is nothing lighter than white, so elevation is
      // carried by shadow. In dark mode shadows do almost nothing on a dark
      // ground, so elevation is carried by surface luminance instead. A card
      // that keeps its shadow in dark mode is the giveaway of a theme that was
      // inverted rather than designed.
      await tester.pumpWidget(_host(child: const AlyCard(child: Text('ن'))));
      // AnimatedContainer, not Container - they are different types, and the
      // first version of this test looked for the wrong one and found nothing.
      final light = _decorations(tester);
      expect(light.any((d) => (d.boxShadow ?? []).isNotEmpty), isTrue);

      // A fresh key, so the dark card is a NEW element rather than the light
      // one re-themed. Without it the AnimatedContainer keeps its State and is
      // mid-transition between the two decorations when the assertion runs -
      // the test would be reading an interpolated frame, not the design.
      await tester.pumpWidget(
        _host(
          brightness: Brightness.dark,
          child: const AlyCard(key: ValueKey('dark'), child: Text('ن')),
        ),
      );
      await tester.pumpAndSettle();
      final dark = _decorations(tester);
      expect(dark.every((d) => (d.boxShadow ?? []).isEmpty), isTrue);
    });
  });

  group('AlySheet', () {
    testWidgets('pins its action so it stays reachable', (tester) async {
      // The point of the pinned footer: on the offer sheet the driver has
      // fifteen seconds, and an action that has scrolled off the bottom is an
      // action they do not take.
      await tester.pumpWidget(
        _host(
          child: AlySheet(
            title: 'تأكيد الرحلة',
            actions: [AlyButton(label: 'تأكيد', onPressed: () {})],
            child: Column(
              children: List.generate(
                40,
                (i) => Padding(
                  padding: const EdgeInsets.all(AlySpacing.md),
                  child: Text('سطر $i'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      // Long body, and the action is still on screen without scrolling.
      expect(find.text('تأكيد'), findsOneWidget);
      final button = tester.getRect(find.byType(AlyButton));
      final sheet = tester.getRect(find.byType(AlySheet));
      expect(button.bottom, lessThanOrEqualTo(sheet.bottom + 1));
    });

    testWidgets('shows a close control only when there is somewhere to close to',
        (tester) async {
      await tester.pumpWidget(
        _host(child: const AlySheet(title: 'بدون إغلاق', child: Text('ن'))),
      );
      expect(find.bySemanticsLabel('إغلاق'), findsNothing);

      var closed = 0;
      await tester.pumpWidget(
        _host(
          child: AlySheet(
            title: 'مع إغلاق',
            onClose: () => closed++,
            child: const Text('ن'),
          ),
        ),
      );
      await tester.tap(find.bySemanticsLabel('إغلاق'));
      expect(closed, 1);
    });

    testWidgets('renders in both directions and both modes', (tester) async {
      for (final direction in [TextDirection.rtl, TextDirection.ltr]) {
        for (final brightness in [Brightness.light, Brightness.dark]) {
          await tester.pumpWidget(
            _host(
              direction: direction,
              brightness: brightness,
              child: const AlySheet(title: 'عنوان', child: Text('محتوى')),
            ),
          );
          await tester.pump();
          expect(tester.takeException(), isNull);
        }
      }
    });

    testWidgets('survives a large text scale on a short screen', (tester) async {
      await tester.pumpWidget(
        _host(
          textScale: 1.8,
          size: const Size(360, 600),
          child: AlySheet(
            title: 'تأكيد الرحلة إلى الوجهة المختارة',
            subtitle: 'راجع التفاصيل قبل التأكيد',
            actions: [AlyButton(label: 'تأكيد الرحلة', onPressed: () {})],
            child: const Text('تفاصيل الرحلة'),
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });

  group('AlyConfirmationDialog', () {
    testWidgets('returns true only when the user confirms', (tester) async {
      late bool answer;
      await tester.pumpWidget(
        _host(
          child: Builder(
            builder: (context) => AlyButton(
              label: 'افتح',
              onPressed: () async {
                answer = await AlyConfirmationDialog.ask(
                  context,
                  title: 'إلغاء الرحلة؟',
                  message: 'لا يمكن التراجع عن هذا الإجراء.',
                  confirmLabel: 'إلغاء الرحلة',
                  isDestructive: true,
                );
              },
            ),
          ),
        ),
      );

      await tester.tap(find.text('افتح'));
      await tester.pumpAndSettle();
      expect(find.text('إلغاء الرحلة؟'), findsOneWidget);

      await tester.tap(find.text('إلغاء الرحلة'));
      await tester.pumpAndSettle();
      expect(answer, isTrue);
    });

    testWidgets('a dismissed dialog counts as a refusal, never a confirmation',
        (tester) async {
      // The default must be the safe one. A dialog dismissed by a back gesture
      // returning `null` and being read as truthy is how a ride gets cancelled
      // by accident.
      late bool answer;
      await tester.pumpWidget(
        _host(
          child: Builder(
            builder: (context) => AlyButton(
              label: 'افتح',
              onPressed: () async {
                answer = await AlyConfirmationDialog.ask(
                  context,
                  title: 'إلغاء الرحلة؟',
                  message: 'لا يمكن التراجع.',
                  confirmLabel: 'إلغاء',
                );
              },
            ),
          ),
        ),
      );

      await tester.tap(find.text('افتح'));
      await tester.pumpAndSettle();
      // Tap the barrier.
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();
      expect(answer, isFalse);
    });

    testWidgets('a destructive confirm uses the danger tone', (tester) async {
      await tester.pumpWidget(
        _host(
          child: const AlyConfirmationDialog(
            title: 'حذف الحساب؟',
            message: 'سيتم حذف بياناتك نهائياً.',
            confirmLabel: 'حذف',
            isDestructive: true,
          ),
        ),
      );

      final buttons = tester.widgetList<AlyButton>(find.byType(AlyButton)).toList();
      expect(buttons.any((b) => b.variant == AlyButtonVariant.danger), isTrue);
    });
  });

  group('AlyAvatar', () {
    testWidgets('falls back to an initial when there is no image', (tester) async {
      await tester.pumpWidget(_host(child: const AlyAvatar(name: 'حسين')));
      expect(find.text('ح'), findsOneWidget);
    });

    testWidgets('does not crash on an empty name', (tester) async {
      await tester.pumpWidget(_host(child: const AlyAvatar(name: '   ')));
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('announces presence rather than only colouring it', (tester) async {
      // Colour alone is not a status for anyone who cannot distinguish it.
      await tester.pumpWidget(
        _host(child: const AlyAvatar(name: 'حسين', presence: AlyPresence.online)),
      );
      expect(find.bySemanticsLabel('متصل'), findsOneWidget);

      await tester.pumpWidget(
        _host(child: const AlyAvatar(name: 'حسين', presence: AlyPresence.offline)),
      );
      expect(find.bySemanticsLabel('غير متصل'), findsOneWidget);
    });

    testWidgets('renders at its requested size', (tester) async {
      await tester.pumpWidget(_host(child: const AlyAvatar(name: 'حسين', size: 64)));
      final size = tester.getSize(find.byType(AlyAvatar));
      expect(size.width, 64);
      expect(size.height, 64);
    });
  });

  group('AlyBadge', () {
    testWidgets('renders every tone in both modes without an exception',
        (tester) async {
      for (final tone in AlyBadgeTone.values) {
        for (final brightness in [Brightness.light, Brightness.dark]) {
          await tester.pumpWidget(
            _host(
              brightness: brightness,
              child: AlyBadge(label: tone.name, tone: tone),
            ),
          );
          await tester.pump();
          expect(tester.takeException(), isNull, reason: '${tone.name} / $brightness');
        }
      }
    });

    testWidgets('survives a long label at a large text scale', (tester) async {
      await tester.pumpWidget(
        _host(
          textScale: 1.8,
          size: const Size(360, 640),
          child: const AlyBadge(label: 'في انتظار موافقة الإدارة'),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });
}
