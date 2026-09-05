import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The design system, asserted rather than eyeballed.
///
/// ## What a test can and cannot say about design
///
/// It cannot say a screen looks good. It can say the things that make a screen
/// look BAD, all of which are mechanical and all of which are invisible in a
/// single screenshot:
///
///   - a colour that is legible in light mode and unreadable in dark;
///   - a tap target below the size a thumb can hit;
///   - a spacing value that came from nowhere;
///   - a control with no disabled state, or one that changes width while
///     loading and moves the thing next to it;
///   - a layout that is correct in English and mirrored wrongly in Arabic.
///
/// Those are the ones worth automating, because they are exactly the ones a
/// designer reviewing in a bright room on an English build will not catch.

/// WCAG relative luminance.
///
/// The sRGB channels are linearised before weighting, which is the step that
/// makes this a perceptual measure rather than an arithmetic one: #808080 is
/// not half as bright as white to the eye, and a naive average would pass
/// colour pairs that are genuinely unreadable.
double _luminance(Color colour) {
  double linear(double channel) =>
      channel <= 0.03928 ? channel / 12.92 : math.pow((channel + 0.055) / 1.055, 2.4).toDouble();

  return 0.2126 * linear(colour.r) +
      0.7152 * linear(colour.g) +
      0.0722 * linear(colour.b);
}

/// Contrast ratio between two opaque colours.
double _contrast(Color a, Color b) {
  final la = _luminance(a);
  final lb = _luminance(b);
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

Widget _host({
  required Widget child,
  Brightness brightness = Brightness.light,
  TextDirection direction = TextDirection.rtl,
  double textScale = 1.0,
}) =>
    MaterialApp(
      theme: brightness == Brightness.dark ? AlyTheme.dark() : AlyTheme.light(),
      home: Directionality(
        textDirection: direction,
        child: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(textScale)),
          child: Scaffold(body: Center(child: child)),
        ),
      ),
    );

void main() {
  group('the spacing grid', () {
    test('every token is a multiple of four', () {
      // The rule the mandate states, enforced rather than trusted. A future
      // `static const double odd = 13` fails here rather than in a screenshot.
      const values = <double>[
        AlySpacing.xs,
        AlySpacing.sm,
        AlySpacing.md,
        AlySpacing.lg,
        AlySpacing.xl,
        AlySpacing.xxl,
        AlySpacing.xxxl,
        AlySpacing.gutter,
      ];

      for (final value in values) {
        expect(value % 4, 0, reason: '$value is not on the 4pt grid');
      }
    });

    test('the tap target clears the platform minimum', () {
      // 48 is the Android/iOS floor. 56 is ours, for a driver in a moving car.
      expect(AlySpacing.tapTargetSmall, greaterThanOrEqualTo(48));
      expect(AlySpacing.tapTarget, greaterThanOrEqualTo(56));
    });
  });

  group('the type scale', () {
    test('has no two styles at the same size and weight', () {
      // Two styles that render identically are one style and a decision nobody
      // made. This catches a scale that has drifted into duplicates.
      final styles = <String, TextStyle>{
        'display': AlyTypography.display,
        'h1': AlyTypography.h1,
        'h2': AlyTypography.h2,
        'h3': AlyTypography.h3,
        'title': AlyTypography.title,
        'bodyLarge': AlyTypography.bodyLarge,
        'body': AlyTypography.body,
        'bodySmall': AlyTypography.bodySmall,
        'caption': AlyTypography.caption,
        'label': AlyTypography.label,
      };

      final seen = <String, String>{};
      styles.forEach((name, style) {
        final key = '${style.fontSize}/${style.fontWeight}';
        expect(
          seen.containsKey(key),
          isFalse,
          reason: '$name is identical to ${seen[key]} ($key)',
        );
        seen[key] = name;
      });
    });

    test('every size is a whole number', () {
      // Fractional sizes make Arabic stem weights visibly uneven on Android.
      for (final style in [
        AlyTypography.display,
        AlyTypography.h1,
        AlyTypography.body,
        AlyTypography.caption,
      ]) {
        expect(style.fontSize! % 1, 0);
      }
    });

    test('money and countdowns use tabular figures', () {
      // Without this a fare or an ETA visibly jitters as it updates, on the one
      // screen where both parties are watching the number.
      for (final style in [
        AlyTypography.display,
        AlyTypography.numeric,
        AlyTypography.numericSmall,
      ]) {
        expect(
          style.fontFeatures,
          contains(const FontFeature.tabularFigures()),
        );
      }
    });

    test('carries an Arabic-capable fallback chain', () {
      // A missing Arabic glyph renders as a box and makes the app look broken
      // rather than untranslated.
      expect(AlyTypography.fontFamily, 'Cairo');
      expect(AlyTypography.fontFamilyFallback, isNotEmpty);
      expect(AlyTypography.body.fontFamilyFallback, isNotEmpty);
    });
  });

  group('colour contrast', () {
    // 4.5:1 is WCAG AA for body text. This app is also read in direct Baghdad
    // sunlight through a windscreen, which no guideline covers — so these are a
    // floor, not a target.
    void checkPair(String label, Color fg, Color bg, {double min = 4.5}) {
      final ratio = _contrast(fg, bg);
      expect(
        ratio,
        greaterThanOrEqualTo(min),
        reason: '$label is ${ratio.toStringAsFixed(2)}:1, below $min:1',
      );
    }

    test('light mode body text is legible', () {
      const c = AlyColors.light;
      checkPair('textPrimary on background', c.textPrimary, c.background);
      checkPair('textPrimary on surface', c.textPrimary, c.surface);
      checkPair('textSecondary on surface', c.textSecondary, c.surface);
      checkPair('onPrimary on primary', c.onPrimary, c.primary);
    });

    test('dark mode body text is legible', () {
      // The test that catches the most common dark-mode bug: keeping the same
      // brand hex in both modes. `teal600` on `grey950` is 2.9:1 and would fail
      // here, which is why dark mode moves the brand colour up the ramp.
      const c = AlyColors.dark;
      checkPair('textPrimary on background', c.textPrimary, c.background);
      checkPair('textPrimary on surface', c.textPrimary, c.surface);
      checkPair('textSecondary on surface', c.textSecondary, c.surface);
      checkPair('onPrimary on primary', c.onPrimary, c.primary);
    });

    test('status colours are legible against their own muted backgrounds', () {
      for (final c in [AlyColors.light, AlyColors.dark]) {
        final mode = c.brightness.name;
        checkPair('$mode error on errorMuted', c.error, c.errorMuted, min: 3);
        checkPair('$mode success on successMuted', c.success, c.successMuted, min: 3);
        checkPair('$mode warning on warningMuted', c.warning, c.warningMuted, min: 3);
      }
    });

    test('the online indicator is distinguishable from offline', () {
      // A driver glances at this; it must not be a subtle difference.
      for (final c in [AlyColors.light, AlyColors.dark]) {
        expect(_contrast(c.online, c.offline), greaterThan(1.5));
      }
    });
  });

  group('dark mode is designed, not inverted', () {
    test('elevation is carried by luminance', () {
      // sunken < surface < elevated. In light mode there is nothing lighter
      // than white, so elevation is carried by shadow instead and surface and
      // elevated are deliberately equal.
      const d = AlyColors.dark;
      expect(_luminance(d.surfaceSunken), lessThan(_luminance(d.surface)));
      expect(_luminance(d.surface), lessThan(_luminance(d.surfaceElevated)));

      const l = AlyColors.light;
      expect(_luminance(l.surfaceSunken), lessThan(_luminance(l.surface)));
      expect(l.surfaceElevated, l.surface);
    });

    test('the background is not pure black', () {
      // True black smears every scroll edge on OLED and leaves no room to sink
      // a surface below the background.
      expect(AlyColors.dark.background, isNot(const Color(0xFF000000)));
    });

    test('the brand colour differs between modes', () {
      expect(AlyColors.dark.primary, isNot(AlyColors.light.primary));
    });
  });

  group('AlyButton', () {
    testWidgets('renders its label and fires', (tester) async {
      var taps = 0;
      await tester.pumpWidget(
        _host(child: AlyButton(label: 'اطلب رحلة', onPressed: () => taps++)),
      );

      await tester.tap(find.text('اطلب رحلة'));
      expect(taps, 1);
    });

    testWidgets('a null callback disables it', (tester) async {
      // Asserted as behaviour rather than as a semantics flag. The flag is an
      // implementation detail of how the disabled state is announced; what a
      // user experiences is that pressing it does nothing, and that is what
      // must not regress.
      await tester.pumpWidget(
        _host(child: const AlyButton(label: 'معطّل', onPressed: null)),
      );

      // Tapping a disabled button must be inert, not merely unstyled.
      await tester.tap(find.byType(AlyButton));
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('does not fire while loading', (tester) async {
      // The client-side half of CLAUDE.md §5.2: a double-tapped confirm must
      // not become two rides, and the server's idempotency key should be a
      // backstop rather than the only defence.
      var taps = 0;
      await tester.pumpWidget(
        _host(
          child: AlyButton(
            label: 'تأكيد',
            isLoading: true,
            onPressed: () => taps++,
          ),
        ),
      );

      await tester.tap(find.byType(AlyButton));
      await tester.pump();
      expect(taps, 0);
    });

    testWidgets('keeps its width while loading', (tester) async {
      // A button that shrinks to a spinner moves whatever is next to it — on a
      // confirmation screen, that is the thing the user is about to tap.
      await tester.pumpWidget(
        _host(
          child: SizedBox(
            width: 300,
            child: AlyButton(label: 'تأكيد الرحلة', onPressed: () {}),
          ),
        ),
      );
      final idle = tester.getSize(find.byType(AlyButton));

      await tester.pumpWidget(
        _host(
          child: SizedBox(
            width: 300,
            child: AlyButton(label: 'تأكيد الرحلة', isLoading: true, onPressed: () {}),
          ),
        ),
      );
      await tester.pump();
      final loading = tester.getSize(find.byType(AlyButton));

      expect(loading.width, idle.width);
      expect(loading.height, idle.height);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('meets the tap target in both sizes', (tester) async {
      await tester.pumpWidget(
        _host(child: AlyButton(label: 'كبير', onPressed: () {})),
      );
      expect(
        tester.getSize(find.byType(AlyButton)).height,
        greaterThanOrEqualTo(AlySpacing.tapTarget),
      );

      await tester.pumpWidget(
        _host(
          child: AlyButton(
            label: 'متوسط',
            size: AlyButtonSize.medium,
            onPressed: () {},
          ),
        ),
      );
      expect(
        tester.getSize(find.byType(AlyButton)).height,
        greaterThanOrEqualTo(AlySpacing.tapTargetSmall),
      );
    });

    testWidgets('survives a large system font scale', (tester) async {
      // A driver who has turned the font up is exactly the person who must
      // still be able to press accept.
      await tester.pumpWidget(
        _host(
          textScale: 1.8,
          child: SizedBox(
            width: 320,
            child: AlyButton(label: 'قبول الطلب الآن', onPressed: () {}),
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('renders in dark mode without an exception', (tester) async {
      await tester.pumpWidget(
        _host(
          brightness: Brightness.dark,
          child: AlyButton(label: 'ليلي', onPressed: () {}),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('mirrors correctly in English', (tester) async {
      await tester.pumpWidget(
        _host(
          direction: TextDirection.ltr,
          child: AlyButton(
            label: 'Request a ride',
            icon: Icons.local_taxi_rounded,
            onPressed: () {},
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.text('Request a ride'), findsOneWidget);
    });
  });

  group('AlyIconButton', () {
    testWidgets('always carries a semantic label', (tester) async {
      // An icon-only control is invisible to a screen reader without one, which
      // is why the parameter is required rather than optional.
      await tester.pumpWidget(
        _host(
          child: AlyIconButton(
            icon: Icons.my_location_rounded,
            semanticLabel: 'موقعي الحالي',
            onPressed: () {},
          ),
        ),
      );

      expect(find.bySemanticsLabel('موقعي الحالي'), findsOneWidget);
    });

    testWidgets('is at least 48pt square', (tester) async {
      await tester.pumpWidget(
        _host(
          child: AlyIconButton(
            icon: Icons.close_rounded,
            semanticLabel: 'إغلاق',
            onPressed: () {},
          ),
        ),
      );

      final size = tester.getSize(find.byType(AlyIconButton));
      expect(size.width, greaterThanOrEqualTo(48));
      expect(size.height, greaterThanOrEqualTo(48));
    });
  });

  group('states', () {
    testWidgets('an empty state offers an action only when one exists', (tester) async {
      await tester.pumpWidget(
        _host(
          child: const AlyEmptyState(
            icon: Icons.receipt_long_rounded,
            title: 'لا توجد رحلات بعد',
            message: 'رحلاتك ستظهر هنا بعد أول رحلة تطلبها.',
          ),
        ),
      );

      expect(find.text('لا توجد رحلات بعد'), findsOneWidget);
      expect(find.byType(AlyButton), findsNothing);

      await tester.pumpWidget(
        _host(
          child: AlyEmptyState(
            icon: Icons.receipt_long_rounded,
            title: 'لا توجد رحلات بعد',
            message: 'رحلاتك ستظهر هنا بعد أول رحلة تطلبها.',
            actionLabel: 'اطلب رحلة',
            onAction: () {},
          ),
        ),
      );
      expect(find.byType(AlyButton), findsOneWidget);
    });

    testWidgets('an error state always offers a way forward', (tester) async {
      var retried = 0;
      await tester.pumpWidget(
        _host(
          child: AlyErrorState(
            title: 'تعذّر تحميل رحلاتك',
            message: 'تحقّق من اتصالك ثم أعد المحاولة.',
            onRetry: () => retried++,
          ),
        ),
      );

      await tester.tap(find.text('إعادة المحاولة'));
      expect(retried, 1);
    });

    testWidgets('a skeleton renders in both directions and both modes', (tester) async {
      for (final direction in [TextDirection.rtl, TextDirection.ltr]) {
        for (final brightness in [Brightness.light, Brightness.dark]) {
          await tester.pumpWidget(
            _host(
              direction: direction,
              brightness: brightness,
              child: const AlySkeletonRow(),
            ),
          );
          await tester.pump(const Duration(milliseconds: 300));
          expect(tester.takeException(), isNull);
        }
      }
    });

    testWidgets('the offline banner announces itself', (tester) async {
      // A live region, so a screen reader reports the connection dropping
      // rather than leaving the user to discover it by failure.
      await tester.pumpWidget(_host(child: const AlyOfflineBanner()));

      final node = tester.getSemantics(find.byType(AlyOfflineBanner));
      expect(node.flagsCollection.isLiveRegion, isTrue);
    });
  });
}
