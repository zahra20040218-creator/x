import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Driver mode, asserted rather than eyeballed.
///
/// The console is the surface where a rendering bug costs money: a driver who
/// cannot tell whether they are online either misses fares or leaves the app
/// running all night. So these tests assert behaviour — what fires, what does
/// NOT fire, what survives a second tap — rather than that a widget appeared.
///
/// Four failure modes are checked for every widget, because all four are
/// invisible when reviewing an Arabic light-mode build at 1.0 text scale:
/// mirrored layout, dark mode, a callback that fires when it should not, and
/// a large accessibility text scale.

Widget _host({
  required Widget child,
  Brightness brightness = Brightness.light,
  TextDirection direction = TextDirection.rtl,
  double textScale = 1.0,
  bool scroll = false,
}) =>
    MaterialApp(
      theme: brightness == Brightness.dark ? AlyTheme.dark() : AlyTheme.light(),
      home: Directionality(
        textDirection: direction,
        child: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(textScale)),
          child: Scaffold(
            body: scroll
                ? SingleChildScrollView(child: Padding(
                    padding: const EdgeInsets.all(AlySpacing.gutter),
                    child: child,
                  ),)
                : Center(
                    child: Padding(
                      padding: const EdgeInsets.all(AlySpacing.gutter),
                      child: child,
                    ),
                  ),
          ),
        ),
      ),
    );

/// Advances past the design system's transitions without waiting on the ones
/// that never end.
///
/// `pumpAndSettle` cannot be used anywhere near this file: a busy toggle and a
/// renewing subscription both show a [CircularProgressIndicator], which is an
/// infinite animation, and `pumpAndSettle` times out rather than settling. Two
/// pumps past [AlyMotion.fast] is enough for everything that does finish.
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

/// Renders the widget in all four combinations of direction and brightness.
///
/// A single assertion per combination, because what is being tested is that
/// nothing throws: a `left`/`right` edge inset or a colour read from the wrong
/// theme shows up here and nowhere else in the suite.
Future<void> _rendersEveryMode(WidgetTester tester, Widget child) async {
  for (final direction in TextDirection.values) {
    for (final brightness in Brightness.values) {
      await tester.pumpWidget(
        _host(child: child, direction: direction, brightness: brightness),
      );
      await _settle(tester);
      expect(
        tester.takeException(),
        isNull,
        reason: 'threw in $direction / $brightness',
      );
    }
  }
}

/// A narrow phone at the largest text scale the platform offers.
///
/// 1080x2400 at dpr 3 is 360x800 logical — a real Android handset, and narrow
/// enough that a `Row` which should have been a `Wrap` overflows here.
Future<void> _survivesLargeText(
  WidgetTester tester,
  Widget child, {
  bool scroll = false,
}) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(_host(child: child, textScale: 1.8, scroll: scroll));
  await _settle(tester);
  expect(tester.takeException(), isNull);
}

void main() {
  group('AlyOnlineToggle', () {
    testWidgets('states the state in words, not by the position of a thumb',
        (tester) async {
      await tester.pumpWidget(
        _host(child: AlyOnlineToggle(isOnline: false, onChanged: (_) {})),
      );
      await _settle(tester);

      expect(find.text('أنت غير متصل'), findsOneWidget);
      expect(find.text('اضغط لتصبح متاحاً وتبدأ باستقبال الطلبات.'), findsOneWidget);
      // Not a platform Switch. CLAUDE.md's driver console gives this control the
      // whole width; a Switch here would be a regression.
      expect(find.byType(Switch), findsNothing);
    });

    testWidgets('online reads as online and carries the online colour',
        (tester) async {
      await tester.pumpWidget(
        _host(child: AlyOnlineToggle(isOnline: true, onChanged: (_) {})),
      );
      await _settle(tester);

      expect(find.text('أنت متصل'), findsOneWidget);
      expect(find.text('تصلك طلبات الرحلات الآن. أبقِ التطبيق يعمل.'), findsOneWidget);

      final container = tester.widget<AnimatedContainer>(
        find.byType(AnimatedContainer),
      );
      final decoration = container.decoration! as BoxDecoration;
      expect(decoration.color, AlyColors.light.online);
    });

    testWidgets('going online shows a spinner and the label says so',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyOnlineToggle(isOnline: false, isBusy: true, onChanged: (_) {}),
        ),
      );
      await tester.pump();

      expect(find.text('جارٍ الاتصال…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('a tap asks for the opposite of the confirmed state',
        (tester) async {
      final requested = <bool>[];

      await tester.pumpWidget(
        _host(child: AlyOnlineToggle(isOnline: false, onChanged: requested.add)),
      );
      await tester.tap(find.byIcon(Icons.power_settings_new_rounded));
      await tester.pump(const Duration(seconds: 1));

      expect(requested, [true]);

      await tester.pumpWidget(
        _host(child: AlyOnlineToggle(isOnline: true, onChanged: requested.add)),
      );
      await tester.tap(find.byIcon(Icons.power_settings_new_rounded));
      await tester.pump(const Duration(seconds: 1));

      expect(requested, [true, false]);
    });

    testWidgets('does not fire when the caller has disabled it', (tester) async {
      var fired = 0;

      await tester.pumpWidget(
        _host(child: const AlyOnlineToggle(isOnline: false, onChanged: null)),
      );
      await tester.tap(find.byIcon(Icons.power_settings_new_rounded));
      await tester.pump(const Duration(seconds: 1));

      expect(fired, 0);
      expect(find.text('لا يمكنك تغيير حالتك الآن.'), findsOneWidget);

      // And nothing fires while a request is in flight either.
      await tester.pumpWidget(
        _host(
          child: AlyOnlineToggle(
            isOnline: false,
            isBusy: true,
            onChanged: (_) => fired++,
          ),
        ),
      );
      await tester.tap(find.byIcon(Icons.power_settings_new_rounded));
      await tester.pump(const Duration(seconds: 1));

      expect(fired, 0);
    });

    testWidgets('a double tap in the handoff window fires once', (tester) async {
      // The dangerous case: a caller that awaits the request before it reports
      // `isBusy`, so there is no `isBusy` for the second tap to bounce off.
      var fired = 0;

      await tester.pumpWidget(
        _host(child: AlyOnlineToggle(isOnline: false, onChanged: (_) => fired++)),
      );

      final target = find.byIcon(Icons.power_settings_new_rounded);
      await tester.tap(target);
      await tester.pump();
      await tester.tap(target);
      await tester.pump();
      await tester.tap(target);
      await tester.pump();

      expect(fired, 1, reason: 'two drivers-worth of requests from one thumb');

      // The latch must not wedge the shift button forever if the caller never
      // answers: after the handoff window the control works again.
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(target);
      await tester.pump(const Duration(seconds: 1));

      expect(fired, 2);
    });

    testWidgets('renders in RTL, LTR, light and dark', (tester) async {
      await _rendersEveryMode(
        tester,
        AlyOnlineToggle(isOnline: true, onChanged: (_) {}),
      );
    });

    testWidgets('survives a 1.8x text scale on a narrow phone', (tester) async {
      await _survivesLargeText(
        tester,
        AlyOnlineToggle(isOnline: false, onChanged: (_) {}),
      );
    });
  });

  group('AlyEarningsCard', () {
    const card = AlyEarningsCard(
      todayIqd: 87500,
      tripCount: 9,
      onlineTime: Duration(hours: 5, minutes: 45),
    );

    testWidgets('the figure, the trips and the online time', (tester) async {
      await tester.pumpWidget(_host(child: card));
      await _settle(tester);

      expect(find.text('أرباح اليوم'), findsOneWidget);
      expect(find.text('87,500 د.ع'), findsOneWidget);
      expect(find.text('9'), findsOneWidget);
      expect(find.text('الرحلات'), findsOneWidget);
      expect(find.text('5 س 45 د'), findsOneWidget);
      expect(find.text('مدة الاتصال'), findsOneWidget);
    });

    testWidgets('the money is rendered through FareText, never as a raw number',
        (tester) async {
      await tester.pumpWidget(_host(child: card));
      await _settle(tester);

      expect(find.byType(FareText), findsOneWidget);
      expect(find.text('87500'), findsNothing);
    });

    testWidgets('a better day than yesterday reads as up', (tester) async {
      await tester.pumpWidget(
        _host(
          child: const AlyEarningsCard(
            todayIqd: 87500,
            tripCount: 9,
            onlineTime: Duration(hours: 5),
            yesterdayIqd: 75000,
          ),
        ),
      );
      await _settle(tester);

      expect(find.byIcon(Icons.trending_up_rounded), findsOneWidget);
      expect(find.text('12,500 د.ع'), findsOneWidget);
      expect(find.text('أكثر من أمس'), findsOneWidget);
    });

    testWidgets('a worse day reads as down, and is not coloured as an error',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: const AlyEarningsCard(
            todayIqd: 40000,
            tripCount: 4,
            onlineTime: Duration(hours: 3),
            yesterdayIqd: 75000,
          ),
        ),
      );
      await _settle(tester);

      expect(find.byIcon(Icons.trending_down_rounded), findsOneWidget);
      expect(find.text('35,000 د.ع'), findsOneWidget);
      expect(find.text('أقل من أمس'), findsOneWidget);

      final arrow = tester.widget<Icon>(find.byIcon(Icons.trending_down_rounded));
      expect(
        arrow.color,
        isNot(AlyColors.light.error),
        reason: 'a slow morning is not an error state',
      );
    });

    testWidgets('an equal day says so without a delta figure', (tester) async {
      await tester.pumpWidget(
        _host(
          child: const AlyEarningsCard(
            todayIqd: 75000,
            tripCount: 7,
            onlineTime: Duration(hours: 4, minutes: 10),
            yesterdayIqd: 75000,
          ),
        ),
      );
      await _settle(tester);

      expect(find.byIcon(Icons.trending_flat_rounded), findsOneWidget);
      expect(find.text('مثل أمس'), findsOneWidget);
      // The headline figure only — no "0 د.ع" delta.
      expect(find.byType(FareText), findsOneWidget);
    });

    testWidgets('no comparison at all when yesterday is unknown', (tester) async {
      await tester.pumpWidget(_host(child: card));
      await _settle(tester);

      expect(find.byIcon(Icons.trending_up_rounded), findsNothing);
      expect(find.byIcon(Icons.trending_down_rounded), findsNothing);
      expect(find.byIcon(Icons.trending_flat_rounded), findsNothing);
    });

    testWidgets('the statement action fires, and is absent when unwired',
        (tester) async {
      var opened = 0;

      await tester.pumpWidget(
        _host(
          child: AlyEarningsCard(
            todayIqd: 87500,
            tripCount: 9,
            onlineTime: const Duration(hours: 5, minutes: 45),
            onViewStatement: () => opened++,
          ),
        ),
      );
      await _settle(tester);
      await tester.tap(find.text('كشف الحساب'));
      await _settle(tester);

      expect(opened, 1);

      await tester.pumpWidget(_host(child: card));
      await _settle(tester);

      expect(find.byType(AlyButton), findsNothing);
      expect(find.text('كشف الحساب'), findsNothing);
    });

    testWidgets('renders in RTL, LTR, light and dark', (tester) async {
      await _rendersEveryMode(
        tester,
        const AlyEarningsCard(
          todayIqd: 87500,
          tripCount: 9,
          onlineTime: Duration(hours: 5, minutes: 45),
          yesterdayIqd: 75000,
        ),
      );
    });

    testWidgets('survives a 1.8x text scale on a narrow phone', (tester) async {
      await _survivesLargeText(
        tester,
        AlyEarningsCard(
          todayIqd: 1287500,
          tripCount: 24,
          onlineTime: const Duration(hours: 11, minutes: 45),
          yesterdayIqd: 75000,
          onViewStatement: () {},
        ),
      );
    });
  });

  group('AlySubscriptionCard', () {
    testWidgets('comfortable: plan, days and the expiry date', (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlySubscriptionCard(
            planName: 'الاشتراك الشهري',
            expiresAt: DateTime(2026, 9, 15),
            daysRemaining: 24,
          ),
        ),
      );
      await _settle(tester);

      expect(find.text('الاشتراك الشهري'), findsOneWidget);
      expect(find.text('يتبقى 24 يوماً'), findsOneWidget);
      expect(find.text('ينتهي في'), findsOneWidget);
      expect(find.text('15/09/2026'), findsOneWidget);
      expect(find.text('اشتراكك فعّال ويمكنك استقبال الطلبات.'), findsOneWidget);
    });

    testWidgets('Arabic counts days the way Arabic counts days', (tester) async {
      // Singular, dual and both plural agreements. `1 أيام` is the tell that
      // nobody who speaks the language read the screen.
      const cases = <int, String>{
        1: 'يتبقى يوم واحد',
        2: 'يتبقى يومان',
        6: 'يتبقى 6 أيام',
        18: 'يتبقى 18 يوماً',
      };

      for (final entry in cases.entries) {
        await tester.pumpWidget(
          _host(
            child: AlySubscriptionCard(
              planName: 'الاشتراك الشهري',
              expiresAt: DateTime(2026, 9, 15),
              daysRemaining: entry.key,
            ),
          ),
        );
        await _settle(tester);

        expect(find.text(entry.value), findsOneWidget);
      }
    });

    testWidgets('seven days or fewer escalates to the warning tone',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlySubscriptionCard(
            planName: 'الاشتراك الشهري',
            expiresAt: DateTime(2026, 9, 15),
            daysRemaining: 7,
            onRenew: () {},
          ),
        ),
      );
      await _settle(tester);

      expect(find.text('جدّد قبل انتهاء المدة حتى لا يتوقف عملك.'), findsOneWidget);

      final decoration = tester
          .widget<Container>(
            find
                .ancestor(
                  of: find.text('يتبقى 7 أيام'),
                  matching: find.byType(Container),
                )
                .last,
          )
          .decoration! as BoxDecoration;
      expect(decoration.color, AlyColors.light.warningMuted);
    });

    testWidgets('expired states the consequence and offers a renewal',
        (tester) async {
      var renewals = 0;

      await tester.pumpWidget(
        _host(
          child: AlySubscriptionCard(
            planName: 'الاشتراك الشهري',
            expiresAt: DateTime(2026, 8, 20),
            daysRemaining: 0,
            onRenew: () => renewals++,
          ),
        ),
      );
      await _settle(tester);

      expect(find.text('انتهى الاشتراك'), findsOneWidget);
      expect(find.text('انتهى في'), findsOneWidget);
      expect(find.text('20/08/2026'), findsOneWidget);
      expect(
        find.text('لا يمكنك استقبال الطلبات حتى تجدّد اشتراكك.'),
        findsOneWidget,
      );

      await tester.tap(find.text('تجديد الاشتراك'));
      await _settle(tester);

      expect(renewals, 1);
    });

    testWidgets('a renewal in flight cannot be fired twice', (tester) async {
      var renewals = 0;

      await tester.pumpWidget(
        _host(
          child: AlySubscriptionCard(
            planName: 'الاشتراك الشهري',
            expiresAt: DateTime(2026, 8, 20),
            daysRemaining: 0,
            isRenewing: true,
            onRenew: () => renewals++,
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.tap(find.byType(AlyButton));
      await tester.pump();

      expect(renewals, 0);
    });

    testWidgets('no renewal action when the caller has nowhere to send them',
        (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlySubscriptionCard(
            planName: 'الاشتراك الشهري',
            expiresAt: DateTime(2026, 8, 20),
            daysRemaining: 0,
          ),
        ),
      );
      await _settle(tester);

      expect(find.byType(AlyButton), findsNothing);
    });

    testWidgets('renders in RTL, LTR, light and dark', (tester) async {
      await _rendersEveryMode(
        tester,
        AlySubscriptionCard(
          planName: 'الاشتراك الشهري',
          expiresAt: DateTime(2026, 8, 20),
          daysRemaining: 3,
          onRenew: () {},
        ),
      );
    });

    testWidgets('survives a 1.8x text scale on a narrow phone', (tester) async {
      await _survivesLargeText(
        tester,
        AlySubscriptionCard(
          planName: 'اشتراك السائقين الشهري المدفوع',
          expiresAt: DateTime(2026, 12, 31),
          daysRemaining: 0,
          onRenew: () {},
        ),
      );
    });
  });

  group('AlyBlockerList', () {
    const everyCode = <String>[
      'ACCOUNT_DISABLED',
      'NOT_A_DRIVER',
      'APPROVAL_PENDING',
      'APPROVAL_REJECTED',
      'SUSPENDED',
      'DOCUMENTS_INCOMPLETE',
      'SUBSCRIPTION_REQUIRED',
    ];

    testWidgets('every documented code renders an Arabic row', (tester) async {
      await tester.pumpWidget(
        _host(child: const AlyBlockerList(codes: everyCode), scroll: true),
      );
      await _settle(tester);

      expect(find.text('لا يمكنك الاتصال الآن'), findsOneWidget);
      for (final title in const [
        'حسابك معطّل',
        'هذا الحساب ليس حساب سائق',
        'طلبك قيد المراجعة',
        'تم رفض طلب الانضمام',
        'حسابك موقوف مؤقتاً',
        'مستنداتك غير مكتملة',
        'اشتراكك غير فعّال',
      ]) {
        expect(find.text(title), findsOneWidget, reason: 'missing row: $title');
      }

      // No English leaked into a user-facing row.
      for (final code in everyCode) {
        expect(find.text(code), findsNothing, reason: '$code shown raw');
      }
    });

    testWidgets('every row says what to DO, not only what is wrong',
        (tester) async {
      for (final code in everyCode) {
        await tester.pumpWidget(_host(child: AlyBlockerList(codes: [code])));
        await _settle(tester);

        // Each row carries a title and an instruction line. Two body texts under
        // the header is the shape; a row that only names the problem has one.
        final instructions = find.byWidgetPredicate(
          (widget) =>
              widget is Text &&
              (widget.data ?? '').contains(RegExp('تواصل|جدّد|انتظر|سجّل|اسأل|زوّد')),
        );
        expect(instructions, findsWidgets, reason: '$code has no instruction');
      }
    });

    testWidgets('an unknown code degrades to a usable row', (tester) async {
      await tester.pumpWidget(
        _host(child: const AlyBlockerList(codes: ['VEHICLE_INSPECTION_OVERDUE'])),
      );
      await _settle(tester);

      expect(tester.takeException(), isNull);
      expect(find.text('هناك شرط غير مستوفٍ'), findsOneWidget);
      expect(find.text('تواصل مع الدعم واذكر لهم الرمز الظاهر أدناه.'), findsOneWidget);
      // The raw code IS shown here, and only here: support needs something to
      // look up when the app is a release behind the server.
      expect(find.text('VEHICLE_INSPECTION_OVERDUE'), findsOneWidget);
    });

    testWidgets('a repeated code is one problem, not two', (tester) async {
      await tester.pumpWidget(
        _host(child: const AlyBlockerList(codes: ['SUSPENDED', 'SUSPENDED'])),
      );
      await _settle(tester);

      expect(find.text('حسابك موقوف مؤقتاً'), findsOneWidget);
    });

    testWidgets('an empty list renders nothing at all', (tester) async {
      await tester.pumpWidget(_host(child: const AlyBlockerList(codes: [])));
      await _settle(tester);

      expect(find.text('لا يمكنك الاتصال الآن'), findsNothing);
      expect(find.byType(AlyButton), findsNothing);
    });

    testWidgets('the action reports the machine code, not the label',
        (tester) async {
      final tapped = <String>[];

      await tester.pumpWidget(
        _host(
          child: AlyBlockerList(
            codes: const ['SUBSCRIPTION_REQUIRED'],
            onAction: tapped.add,
          ),
        ),
      );
      await _settle(tester);
      await tester.tap(find.text('تجديد الاشتراك'));
      await _settle(tester);

      expect(tapped, ['SUBSCRIPTION_REQUIRED']);
    });

    testWidgets('no buttons when there is no handler to receive them',
        (tester) async {
      await tester.pumpWidget(
        _host(child: const AlyBlockerList(codes: everyCode), scroll: true),
      );
      await _settle(tester);

      expect(find.byType(AlyButton), findsNothing);
    });

    testWidgets('a pending review offers no button, because there is nothing '
        'to press', (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyBlockerList(codes: const ['APPROVAL_PENDING'], onAction: (_) {}),
        ),
      );
      await _settle(tester);

      expect(find.text('طلبك قيد المراجعة'), findsOneWidget);
      expect(find.byType(AlyButton), findsNothing);
    });

    testWidgets('renders in RTL, LTR, light and dark', (tester) async {
      await _rendersEveryMode(
        tester,
        AlyBlockerList(
          codes: const ['SUSPENDED', 'SUBSCRIPTION_REQUIRED', 'UNKNOWN_FUTURE_CODE'],
          onAction: (_) {},
        ),
      );
    });

    testWidgets('survives a 1.8x text scale on a narrow phone', (tester) async {
      // Scrolled, because seven blockers at 1.8x are taller than any phone —
      // the caller places this in a scroll view. What is under test here is
      // horizontal fit, which is where a Row that should be a Column fails.
      await _survivesLargeText(
        tester,
        AlyBlockerList(codes: everyCode, onAction: (_) {}),
        scroll: true,
      );
    });
  });
}
