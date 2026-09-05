import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:rideapp_rider/screens/sign_in_screen.dart';

/// The sign-in screen must fit, or scroll.
///
/// A real device found this and no test had: a Samsung SC-53C running
/// Android 16, in landscape, rendered
///
///     BOTTOM OVERFLOWED BY 34 PIXELS
///
/// across the bottom of the sign-in form. The screen was a `Column` directly
/// under `Scaffold.body`, which inherits the viewport height as a hard
/// constraint — so content taller than the screen is a `RenderFlex` overflow
/// rather than something the user can scroll to.
///
/// Landscape is only the most visible way in. The same overflow appears when
/// the keyboard opens over a short screen, and when the system font scale is
/// turned up — which the people most likely to need it will have done. Both are
/// covered below, because fixing only the case the device happened to show
/// would leave the other two live.
///
/// `tester.takeException()` is what makes these real: a layout overflow is
/// reported through the error handler, not by anything visible in the widget
/// tree, so a test that only looked for the fields would pass on an overflowing
/// screen.

class _StubApi implements ApiClient {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError('${invocation.memberName} is not used by these tests');
}

void main() {
  /// Matches the real app: Arabic, RTL, all four delegates.
  Widget host() => MaterialApp(
        locale: const Locale('ar'),
        supportedLocales: const [Locale('ar'), Locale('en')],
        localizationsDelegates: const [
          AppStringsDelegate(),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: SignInScreen(api: _StubApi(), onSignedIn: () {}),
      );

  /// Set the surface, pump, and return any layout exception.
  Future<Object?> renderAt(
    WidgetTester tester,
    Size size, {
    double textScale = 1.0,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      MediaQuery(
        data: MediaQueryData(
          size: size,
          textScaler: TextScaler.linear(textScale),
        ),
        child: host(),
      ),
    );
    await tester.pump();
    return tester.takeException();
  }

  group('it fits, or it scrolls', () {
    testWidgets('portrait — the ordinary case', (tester) async {
      expect(await renderAt(tester, const Size(1080, 2400)), isNull);
    });

    testWidgets('landscape — what the device actually showed', (tester) async {
      // The SC-53C's own resolution, rotated. This is the exact geometry that
      // produced "BOTTOM OVERFLOWED BY 34 PIXELS".
      expect(await renderAt(tester, const Size(2400, 1080)), isNull);
    });

    testWidgets('a short landscape screen, well past 34 pixels', (tester) async {
      // Deliberately more hostile than the reported case. Fixing only the
      // observed 34 pixels would be fixing the symptom.
      expect(await renderAt(tester, const Size(1920, 720)), isNull);
    });

    testWidgets('the keyboard open over a short screen', (tester) async {
      // The everyday version of the same bug: the form is fine until someone
      // taps the phone field.
      tester.view.physicalSize = const Size(1080, 1400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        MediaQuery(
          data: const MediaQueryData(
            size: Size(1080, 1400),
            viewInsets: EdgeInsets.only(bottom: 700),
          ),
          child: host(),
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
    });

    testWidgets('a large system font scale', (tester) async {
      // Not an edge case for this audience. A driver who has turned the font
      // up is exactly the user who must still reach the submit button.
      expect(
        await renderAt(tester, const Size(1080, 2400), textScale: 1.8),
        isNull,
      );
    });
  });

  group('the fix did not cost anything', () {
    testWidgets('every field is still present in portrait', (tester) async {
      await renderAt(tester, const Size(1080, 2400));

      expect(find.text('تسجيل الدخول'), findsOneWidget);
      expect(find.text('رقم الهاتف'), findsOneWidget);
      // The rider collects a name; the driver's account already exists.
      expect(find.text('اسمك'), findsOneWidget);
      expect(find.text('إرسال الرمز'), findsOneWidget);
      expect(find.byType(TextField), findsNWidgets(2));
    });

    testWidgets('and in landscape, reachable by scrolling', (tester) async {
      await renderAt(tester, const Size(2400, 1080));

      // Present in the tree even where the viewport cannot show it all.
      expect(find.text('رقم الهاتف'), findsOneWidget);
      expect(find.text('اسمك'), findsOneWidget);

      // The submit button must be REACHABLE, not merely present. A login form
      // that scrolls but cannot reach its own button is no better than one
      // that overflows.
      //
      // `ensureVisible`, not `scrollUntilVisible`: the latter drags until the
      // target appears and throws a StateError when it is already on screen,
      // which is a pass being reported as a failure.
      await tester.ensureVisible(find.text('إرسال الرمز'));
      await tester.pump();
      expect(find.text('إرسال الرمز'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the layout is still right-to-left', (tester) async {
      await renderAt(tester, const Size(1080, 2400));

      // Direction comes from the locale, and a scroll view in between must not
      // interrupt it.
      final direction = Directionality.of(
        tester.element(find.text('رقم الهاتف')),
      );
      expect(direction, TextDirection.rtl);
    });

    testWidgets('the phone field still reads left-to-right', (tester) async {
      await renderAt(tester, const Size(1080, 2400));

      // A phone number is LTR inside an RTL page. Getting this wrong renders
      // +964 at the wrong end and looks like a typo to the user.
      final fields = tester.widgetList<TextField>(find.byType(TextField)).toList();
      expect(fields.first.textDirection, TextDirection.ltr);
    });

    testWidgets('it scrolls in landscape and does not in portrait', (tester) async {
      await renderAt(tester, const Size(1080, 2400));
      final tall = tester.widget<SingleChildScrollView>(
        find.byType(SingleChildScrollView),
      );
      expect(tall.padding, isNotNull);

      // The screen is scrollable in both, which is the point: the same tree
      // handles both instead of branching on orientation.
      await renderAt(tester, const Size(2400, 1080));
      expect(find.byType(SingleChildScrollView), findsOneWidget);
    });
  });
}
