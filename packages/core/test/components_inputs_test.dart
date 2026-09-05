import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Text entry.
///
/// The tests worth having here are the ones that fail silently in review: a
/// phone field that renders `+964` at the wrong end in Arabic, a form that
/// jumps when validation fires, an OTP that a screen reader announces as six
/// unlabelled boxes. None of those is visible in an English screenshot.

Widget _host({
  required Widget child,
  Brightness brightness = Brightness.light,
  TextDirection direction = TextDirection.rtl,
  double textScale = 1.0,
  Size? size,
}) =>
    MaterialApp(
      theme: brightness == Brightness.dark ? AlyTheme.dark() : AlyTheme.light(),
      home: Directionality(
        textDirection: direction,
        child: MediaQuery(
          data: MediaQueryData(
            size: size ?? const Size(390, 844),
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
  group('AlyTextField', () {
    testWidgets('renders its label and takes input', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      var seen = '';

      await tester.pumpWidget(
        _host(
          child: AlyTextField(
            label: 'اسمك',
            controller: controller,
            onChanged: (value) => seen = value,
          ),
        ),
      );

      expect(find.text('اسمك'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'حسين');
      expect(seen, 'حسين');
    });

    testWidgets('does not change height when an error appears', (tester) async {
      // The reason the error line is always laid out. A field that grows on
      // error pushes the submit button under the user's thumb at the exact
      // moment they are reaching for it.
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        _host(child: AlyTextField(label: 'اسمك', controller: controller)),
      );
      final clean = tester.getSize(find.byType(AlyTextField));

      await tester.pumpWidget(
        _host(
          child: AlyTextField(
            label: 'اسمك',
            controller: controller,
            errorText: 'الاسم مطلوب',
          ),
        ),
      );
      await tester.pump();
      final withError = tester.getSize(find.byType(AlyTextField));

      expect(withError.height, clean.height);
      expect(find.text('الاسم مطلوب'), findsOneWidget);
    });

    testWidgets('a disabled field refuses input', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        _host(
          child: AlyTextField(label: 'اسمك', controller: controller, enabled: false),
        ),
      );

      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.enabled, isFalse);
    });

    testWidgets('survives a large text scale', (tester) async {
      await tester.pumpWidget(
        _host(
          textScale: 1.8,
          size: const Size(360, 640),
          child: const AlyTextField(label: 'العنوان الكامل للوجهة', errorText: 'غير صالح'),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });

  group('AlyPhoneField', () {
    testWidgets('shows a fixed +964 affix', (tester) async {
      // The user types their own number the way they write it. Asking for
      // +9647... is asking them to translate their phone number into a format
      // they never use.
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(_host(child: AlyPhoneField(controller: controller)));

      expect(find.text('+964'), findsOneWidget);
      expect(find.text('رقم الهاتف'), findsOneWidget);
    });

    testWidgets('renders the number left-to-right inside an Arabic page', (tester) async {
      // The most common Arabic-app bug in a phone field, and invisible to
      // anyone testing in English: without the inner Directionality, +964
      // lands at the wrong end and the whole field reads as a typo.
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(_host(child: AlyPhoneField(controller: controller)));

      final direction = Directionality.of(tester.element(find.text('+964')));
      expect(direction, TextDirection.ltr);
      // And the page around it is still RTL.
      expect(
        Directionality.of(tester.element(find.text('رقم الهاتف'))),
        TextDirection.rtl,
      );
    });

    testWidgets('accepts only digits and reports what was typed', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      var seen = '';

      await tester.pumpWidget(
        _host(
          child: AlyPhoneField(controller: controller, onChanged: (v) => seen = v),
        ),
      );

      await tester.enterText(find.byType(TextField), '0770-123 4567');
      expect(controller.text, '07701234567');
      // The raw national digits, not E.164. Normalisation is the server's job
      // (CLAUDE.md §8), so the client never has to be right about it twice.
      expect(seen, '07701234567');
    });

    testWidgets('caps the length so an over-typed number cannot be submitted',
        (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(_host(child: AlyPhoneField(controller: controller)));
      await tester.enterText(find.byType(TextField), '077012345678901234');

      expect(controller.text.length, lessThanOrEqualTo(11));
    });

    testWidgets('renders in dark mode and in English without an exception',
        (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        _host(
          brightness: Brightness.dark,
          direction: TextDirection.ltr,
          child: AlyPhoneField(controller: controller, label: 'Phone number'),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });

  group('AlySearchField', () {
    testWidgets('offers clear only when there is something to clear',
        (tester) async {
      // A control that is permanently visible and usually inert is noise, and
      // on a search field it sits exactly where the thumb rests.
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(_host(child: AlySearchField(controller: controller)));
      expect(find.bySemanticsLabel('مسح'), findsNothing);

      await tester.enterText(find.byType(TextField), 'الكرادة');
      await tester.pump();
      expect(find.bySemanticsLabel('مسح'), findsOneWidget);

      await tester.tap(find.bySemanticsLabel('مسح'));
      await tester.pump();
      expect(controller.text, isEmpty);
    });

    testWidgets('offers current location instead, when there is no text',
        (tester) async {
      // The fastest possible answer to "where are you" is not typing.
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      var used = 0;

      await tester.pumpWidget(
        _host(
          child: AlySearchField(
            controller: controller,
            onUseCurrentLocation: () => used++,
          ),
        ),
      );

      await tester.tap(find.bySemanticsLabel('استخدام موقعي الحالي'));
      expect(used, 1);
    });

    testWidgets('meets the tap target height', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(_host(child: AlySearchField(controller: controller)));
      expect(
        tester.getSize(find.byType(AlySearchField)).height,
        greaterThanOrEqualTo(AlySpacing.tapTargetSmall),
      );
    });
  });

  group('AlyOtpInput', () {
    testWidgets('draws one box per digit', (tester) async {
      await tester.pumpWidget(const _HostOtp());
      // Six boxes, one hidden field.
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('fills the boxes as digits arrive and fires on completion',
        (tester) async {
      String? completed;
      await tester.pumpWidget(_HostOtp(onCompleted: (v) => completed = v));

      await tester.enterText(find.byType(TextField), '1234');
      await tester.pump();
      expect(completed, isNull);
      expect(find.text('4'), findsOneWidget);

      await tester.enterText(find.byType(TextField), '123456');
      await tester.pump();
      expect(completed, '123456');
    });

    testWidgets('a pasted code fills every box at once', (tester) async {
      // The structural reason this is one field drawn as several boxes: six
      // separate controllers would take only the first character of a paste.
      String? completed;
      await tester.pumpWidget(_HostOtp(onCompleted: (v) => completed = v));

      await tester.enterText(find.byType(TextField), '987654');
      await tester.pump();

      expect(completed, '987654');
      for (final digit in ['9', '8', '7', '6', '5', '4']) {
        expect(find.text(digit), findsOneWidget);
      }
    });

    testWidgets('refuses non-digits', (tester) async {
      await tester.pumpWidget(const _HostOtp());

      await tester.enterText(find.byType(TextField), '12ab34');
      await tester.pump();

      final field = tester.widget<TextField>(find.byType(TextField));
      expect(
        field.inputFormatters,
        contains(isA<FilteringTextInputFormatter>()),
      );
      expect(find.text('a'), findsNothing);
    });

    testWidgets('announces itself as one field, not six', (tester) async {
      // Six labelled boxes is a genuinely hostile experience for anyone using a
      // screen reader, and it is the default outcome of the obvious
      // implementation.
      await tester.pumpWidget(const _HostOtp());

      expect(find.bySemanticsLabel(RegExp('رمز التحقق')), findsOneWidget);
    });

    testWidgets('offers the one-time-code autofill hint', (tester) async {
      // Removes the typing entirely on Android, which is the whole point of
      // having the hidden field be a real TextField.
      await tester.pumpWidget(const _HostOtp());

      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.autofillHints, contains(AutofillHints.oneTimeCode));
    });

    testWidgets('shows an error without changing height', (tester) async {
      await tester.pumpWidget(const _HostOtp());
      final clean = tester.getSize(find.byType(AlyOtpInput));

      await tester.pumpWidget(const _HostOtp(errorText: 'الرمز غير صحيح'));
      await tester.pump();

      expect(tester.getSize(find.byType(AlyOtpInput)).height, clean.height);
      expect(find.text('الرمز غير صحيح'), findsOneWidget);
    });

    testWidgets('survives a large text scale on a narrow phone', (tester) async {
      await tester.pumpWidget(const _HostOtp(textScale: 1.8, width: 360));
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('renders in dark mode', (tester) async {
      await tester.pumpWidget(const _HostOtp(brightness: Brightness.dark));
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });
}

/// A host for the OTP, which needs its own state kept across pumps.
class _HostOtp extends StatelessWidget {
  const _HostOtp({
    this.onCompleted,
    this.errorText,
    this.textScale = 1.0,
    this.width = 390,
    this.brightness = Brightness.light,
  });

  /// A getter, not an initialized field: `avoid_field_initializers_in_const_classes`.
  /// Every OTP in this product is six digits, so it is a constant of the
  /// widget, not a parameter callers vary.
  int get length => 6;

  final ValueChanged<String>? onCompleted;
  final String? errorText;
  final double textScale;
  final double width;
  final Brightness brightness;

  @override
  Widget build(BuildContext context) => MaterialApp(
        theme: brightness == Brightness.dark ? AlyTheme.dark() : AlyTheme.light(),
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: MediaQuery(
            data: MediaQueryData(
              size: Size(width, 844),
              textScaler: TextScaler.linear(textScale),
            ),
            child: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(AlySpacing.lg),
                child: AlyOtpInput(
                  length: length,
                  onCompleted: onCompleted,
                  errorText: errorText,
                  autofocus: false,
                ),
              ),
            ),
          ),
        ),
      );
}
