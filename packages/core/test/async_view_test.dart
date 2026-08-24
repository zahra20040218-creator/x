import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Widget tests for the four required states.
///
/// These are real widget tests — they pump a widget tree and assert on what is
/// actually rendered — not snapshot comparisons and not assertions against
/// internal state. A snapshot test would pass on a blank screen as readily as
/// on a correct one.
void main() {
  /// Mirrors the real apps' MaterialApp configuration exactly.
  ///
  /// The first version of this harness set `locale: Locale('ar')` and stopped
  /// there. MaterialApp's default `supportedLocales` is `[en_US]`, so 'ar' was
  /// not supported, resolution fell back to English, and the retry button
  /// rendered "Retry" — while the test looked for 'إعادة المحاولة' and
  /// reported a failure that looked like a missing button.
  ///
  /// The global delegates are equally load-bearing: without
  /// GlobalWidgetsLocalizations there is no Directionality for 'ar', and the
  /// tree renders LTR under an Arabic locale.
  ///
  /// Both apps declare all of this correctly. A test harness that configures
  /// less than the app does not test the app.
  Widget host(Widget child) => MaterialApp(
        locale: const Locale('ar'),
        supportedLocales: const [Locale('ar'), Locale('en')],
        localizationsDelegates: const [
          AppStringsDelegate(),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Scaffold(body: child),
      );

  Widget viewFor(
    ViewState<List<String>> state, {
    VoidCallback? onRetry,
  }) =>
      host(
        AsyncView<List<String>>(
          state: state,
          onRetry: onRetry ?? () {},
          success: (context, data) => Column(
            children: data.map(Text.new).toList(),
          ),
          empty: (context) => const EmptyView(message: 'لا توجد رحلات'),
        ),
      );

  group('the four states render distinctly', () {
    testWidgets('Loading shows a spinner and nothing else', (tester) async {
      await tester.pumpWidget(viewFor(const ViewState<List<String>>.loading()));

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('لا توجد رحلات'), findsNothing);
    });

    testWidgets('Empty shows its message, not a spinner and not an error', (tester) async {
      await tester.pumpWidget(viewFor(const ViewState<List<String>>.empty()));

      expect(find.text('لا توجد رحلات'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.byIcon(Icons.error_outline), findsNothing);
    });

    testWidgets('Error shows the message and a retry button', (tester) async {
      await tester.pumpWidget(
        viewFor(const ViewState<List<String>>.error('لا يوجد اتصال')),
      );

      expect(find.text('لا يوجد اتصال'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline), findsOneWidget);
      expect(find.text('إعادة المحاولة'), findsOneWidget);
    });

    testWidgets('Success renders the data', (tester) async {
      await tester.pumpWidget(
        viewFor(const ViewState<List<String>>.success(['رحلة ١', 'رحلة ٢'])),
      );

      expect(find.text('رحلة ١'), findsOneWidget);
      expect(find.text('رحلة ٢'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });
  });

  group('retry', () {
    testWidgets('the retry button actually invokes the callback', (tester) async {
      var retried = 0;
      await tester.pumpWidget(
        viewFor(
          const ViewState<List<String>>.error('فشل'),
          onRetry: () => retried++,
        ),
      );

      await tester.tap(find.text('إعادة المحاولة'));
      await tester.pump();

      expect(retried, 1);
    });

    // Showing a retry button for an error retrying cannot fix teaches users
    // that the button does nothing.
    testWidgets('an unretryable error shows NO retry button', (tester) async {
      await tester.pumpWidget(
        viewFor(
          const ViewState<List<String>>.error('حسابك موقوف', canRetry: false),
        ),
      );

      expect(find.text('حسابك موقوف'), findsOneWidget);
      expect(find.text('إعادة المحاولة'), findsNothing);
    });
  });

  group('ViewState.fromList', () {
    // "Loaded but nothing there" must not be a success carrying nothing -
    // that is how a blank screen with no explanation gets shipped.
    test('null is Loading, empty is Empty, populated is Success', () {
      expect(ViewState.fromList<String>(null), isA<LoadingState<List<String>>>());
      expect(ViewState.fromList<String>([]), isA<EmptyState<List<String>>>());
      expect(ViewState.fromList<String>(['a']), isA<SuccessState<List<String>>>());
    });

    test('a success carries the data through unchanged', () {
      final state = ViewState.fromList<String>(['a', 'b']);
      expect((state as SuccessState<List<String>>).data, ['a', 'b']);
    });
  });

  group('accessibility', () {
    // A bare spinner is silent to a screen reader.
    testWidgets('the loading state is announced', (tester) async {
      await tester.pumpWidget(viewFor(const ViewState<List<String>>.loading()));

      expect(
        find.bySemanticsLabel('جارٍ التحميل…'),
        findsOneWidget,
      );
    });

    // Brief §13 - touch targets >= 48dp. The retry button is the one a user
    // hits when something has already gone wrong, one-handed and irritated.
    testWidgets('the retry button meets the minimum touch target', (tester) async {
      await tester.pumpWidget(
        viewFor(const ViewState<List<String>>.error('فشل')),
      );

      final size = tester.getSize(find.byType(ElevatedButton));
      expect(size.height, greaterThanOrEqualTo(48));
    });
  });

  group('RTL', () {
    // CLAUDE.md §8 - Arabic primary, RTL. A layout built with left/right rather
    // than start/end silently mirrors wrong.
    testWidgets('renders right-to-left under an Arabic locale', (tester) async {
      await tester.pumpWidget(viewFor(const ViewState<List<String>>.empty()));

      final direction = Directionality.of(
        tester.element(find.text('لا توجد رحلات')),
      );
      expect(direction, TextDirection.rtl);
    });
  });

  group('exhaustiveness', () {
    // The compiler enforces this via the sealed class: a screen that forgets
    // the empty state does not render a blank page, it fails to build. This
    // test documents the guarantee so it is not silently removed later.
    test('every ViewState variant is a distinct type', () {
      final states = <ViewState<List<String>>>[
        const ViewState<List<String>>.loading(),
        const ViewState<List<String>>.empty(),
        const ViewState<List<String>>.error('x'),
        const ViewState<List<String>>.success(['a']),
      ];

      expect(states.map((s) => s.runtimeType).toSet(), hasLength(4));
    });
  });
}
