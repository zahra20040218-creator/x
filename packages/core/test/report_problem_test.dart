import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Reporting a problem with a ride.
///
/// The endpoint behind this existed, was tested server-side, and no app could
/// reach it — so the admin dispute queue could only ever be empty. These cover
/// the client half: that a reason is required, that the wire value matches the
/// server enum, and that a failure leaves the user's text where they typed it.

class _FakeApi implements ApiClient {
  final List<Map<String, Object?>> opened = [];
  bool fail = false;

  @override
  Future<Dispute> openDispute({
    required String rideId,
    required DisputeReason reason,
    String? description,
  }) async {
    if (fail) {
      throw ApiException(
        problem: ApiProblem.network,
        status: 0,
        detail: 'لا يوجد اتصال',
        errors: [],
      );
    }
    opened.add({
      'rideId': rideId,
      'reason': reason.wire,
      'description': description,
    });
    return Dispute(
      id: 'd4f1c2a0-0000-0000-0000-000000000000',
      rideId: rideId,
      status: 'OPEN',
      reasonCode: reason,
      description: description ?? '',
      createdAt: DateTime.utc(2026, 8, 24),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError('${invocation.memberName} is not used by these tests');
}

void main() {
  late _FakeApi api;

  setUp(() => api = _FakeApi());

  /// Mirrors the real apps' MaterialApp configuration, for the same reason the
  /// AsyncView harness does: a harness that configures less than the app is not
  /// testing the app.
  Widget host({
    required List<DisputeReason> reasons,
    void Function(Dispute?)? onResult,
  }) =>
      MaterialApp(
        locale: const Locale('ar'),
        supportedLocales: const [Locale('ar'), Locale('en')],
        localizationsDelegates: const [
          AppStringsDelegate(),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                final result = await showReportProblemSheet(
                  context: context,
                  api: api,
                  rideId: 'ride-1',
                  reasons: reasons,
                );
                onResult?.call(result);
              },
              child: const Text('open'),
            ),
          ),
        ),
      );

  Future<void> openSheet(WidgetTester tester) async {
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  group('the reasons offered', () {
    testWidgets('shows exactly the reasons it was given, in Arabic', (tester) async {
      await tester.pumpWidget(host(reasons: const [
        DisputeReason.fareWrong,
        DisputeReason.driverNoShow,
      ],),);
      await openSheet(tester);

      expect(find.text('الأجرة غير صحيحة'), findsOneWidget);
      expect(find.text('السائق لم يحضر'), findsOneWidget);
      // Not offered to a rider - it is the driver's complaint.
      expect(find.text('الراكب لم يحضر'), findsNothing);
    });

    testWidgets('never shows a raw wire value to the user', (tester) async {
      await tester.pumpWidget(host(reasons: DisputeReason.values));
      await openSheet(tester);

      for (final reason in DisputeReason.values) {
        expect(find.text(reason.wire), findsNothing, reason: reason.wire);
      }
    });
  });

  group('submitting', () {
    testWidgets('cannot submit before a reason is chosen', (tester) async {
      await tester.pumpWidget(host(reasons: const [DisputeReason.unsafe]));
      await openSheet(tester);

      // reasonCode is required by the server enum and there is no sensible
      // default, so an enabled button here could only produce a 422.
      final button = tester.widget<PrimaryButton>(find.byType(PrimaryButton));
      expect(button.onPressed, isNull);

      await tester.tap(find.text('سلوك غير آمن'));
      await tester.pump();

      expect(
        tester.widget<PrimaryButton>(find.byType(PrimaryButton)).onPressed,
        isNotNull,
      );
    });

    testWidgets('sends the wire value the server enum expects', (tester) async {
      await tester.pumpWidget(host(reasons: const [DisputeReason.driverNoShow]));
      await openSheet(tester);

      await tester.tap(find.text('السائق لم يحضر'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'انتظرت عشرين دقيقة');
      await tester.tap(find.text('إرسال البلاغ'));
      await tester.pumpAndSettle();

      expect(api.opened, hasLength(1));
      // Not 'driverNoShow' - the server rejects anything outside its enum.
      expect(api.opened.first['reason'], 'DRIVER_NO_SHOW');
      expect(api.opened.first['description'], 'انتظرت عشرين دقيقة');
    });

    testWidgets('returns the dispute so the caller can show a reference', (tester) async {
      Dispute? result;
      await tester.pumpWidget(host(
        reasons: const [DisputeReason.other],
        onResult: (dispute) => result = dispute,
      ),);
      await openSheet(tester);

      await tester.tap(find.text('مشكلة أخرى'));
      await tester.pump();
      await tester.tap(find.text('إرسال البلاغ'));
      await tester.pumpAndSettle();

      expect(result, isNotNull);
      // A complaint with no receipt is one the user cannot believe was filed.
      expect(result!.reference, 'D4F1C2A0');
    });

    testWidgets('a failure keeps the sheet open with the text still in it', (tester) async {
      api.fail = true;
      await tester.pumpWidget(host(reasons: const [DisputeReason.fareWrong]));
      await openSheet(tester);

      await tester.tap(find.text('الأجرة غير صحيحة'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'دفعت أكثر');
      await tester.tap(find.text('إرسال البلاغ'));
      await tester.pumpAndSettle();

      // Retyping it would be the second insult.
      expect(find.text('دفعت أكثر'), findsOneWidget);
      expect(find.text('لا يوجد اتصال'), findsOneWidget);
      expect(api.opened, isEmpty);
    });
  });

  group('the model', () {
    test('maps every server reason code', () {
      for (final reason in DisputeReason.values) {
        expect(DisputeReason.fromWire(reason.wire), reason);
      }
    });

    test('an unknown code degrades to other rather than throwing', () {
      // The server could add a code before the app ships. Falling back beats
      // crashing a receipt screen.
      expect(DisputeReason.fromWire('SOMETHING_NEW'), DisputeReason.other);
    });

    test('parses what the server actually returns', () {
      final dispute = Dispute.fromJson(const {
        'id': 'a1b2c3d4-0000-0000-0000-000000000000',
        'rideId': 'ride-9',
        'status': 'OPEN',
        'reasonCode': 'UNSAFE',
        'description': '',
        'createdAt': '2026-08-24T09:00:00.000Z',
      });

      expect(dispute.reasonCode, DisputeReason.unsafe);
      expect(dispute.reference, 'A1B2C3D4');
      expect(dispute.createdAt.isUtc, isTrue);
    });
  });
}
