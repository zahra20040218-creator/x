import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Reading a compliance refusal.
///
/// The server sends document CODES, never prose — it does not know the driver's
/// language. These cover the translation boundary, and the case that matters
/// most operationally: a server that names a document type this build has never
/// heard of, which happens the moment the API is deployed ahead of the app.

ApiException refusal(Map<String, dynamic> body) => ApiException(
      problem: ApiProblem.driverNotCompliant,
      status: 403,
      detail: 'One or more required driver documents are missing.',
      extra: {'type': 'driver-not-compliant', ...body},
    );

void main() {
  group('what the server refused for', () {
    test('reads the three lists apart', () {
      final failure = ComplianceFailure.from(refusal({
        'missing': ['NATIONAL_ID'],
        'expired': ['DRIVING_LICENCE'],
        'rejected': ['VEHICLE_REGISTRATION'],
      }),)!;

      // Kept apart because they send the driver to three different places:
      // bring it, renew it, or stop bringing that one.
      expect(failure.missing, [DriverDocumentType.nationalId]);
      expect(failure.expired, [DriverDocumentType.drivingLicence]);
      expect(failure.rejected, [DriverDocumentType.vehicleRegistration]);
    });

    test('handles a refusal with only one kind of problem', () {
      final failure = ComplianceFailure.from(refusal({
        'missing': ['DRIVING_LICENCE'],
        'expired': <String>[],
        'rejected': <String>[],
      }),)!;

      expect(failure.missing, [DriverDocumentType.drivingLicence]);
      expect(failure.expired, isEmpty);
      expect(failure.isUnexplained, isFalse);
    });

    test('is null for any other problem', () {
      final other = ApiException(
        problem: ApiProblem.forbidden,
        status: 403,
        extra: const {'missing': <String>['DRIVING_LICENCE']},
      );

      // A plain 403 is a suspension, not a document problem, and must not be
      // reported to the driver as one.
      expect(ComplianceFailure.from(other), isNull);
    });
  });

  group('a server this build does not fully understand', () {
    test('reports a refusal it cannot name rather than an empty reason', () {
      final failure = ComplianceFailure.from(refusal({
        'missing': ['TAXI_MEDALLION'],
      }),)!;

      // The API can be deployed ahead of the app. Showing the driver a blank
      // reason, or silently letting them think they can work, are both worse
      // than saying the app is out of date.
      expect(failure.isUnexplained, isTrue);
      expect(failure.unknown, ['TAXI_MEDALLION']);
    });

    test('keeps the codes it does understand alongside the ones it does not', () {
      final failure = ComplianceFailure.from(refusal({
        'missing': ['DRIVING_LICENCE', 'TAXI_MEDALLION'],
      }),)!;

      expect(failure.missing, [DriverDocumentType.drivingLicence]);
      expect(failure.unknown, ['TAXI_MEDALLION']);
      expect(failure.isUnexplained, isFalse);
    });

    test('never guesses a document type', () {
      // Falling back to some member would send a driver to fetch the wrong
      // paper - a wasted trip to a government office, not a cosmetic error.
      expect(DriverDocumentType.fromWire('DRIVING_LICENSE'), isNull);
      expect(DriverDocumentType.fromWire(''), isNull);
    });
  });

  group('a malformed body', () {
    test('missing keys are empty, not a crash', () {
      final failure = ComplianceFailure.from(refusal({}))!;

      expect(failure.missing, isEmpty);
      expect(failure.isUnexplained, isTrue);
    });

    test('a non-list value is ignored', () {
      final failure = ComplianceFailure.from(refusal({'missing': 'DRIVING_LICENCE'}))!;

      expect(failure.missing, isEmpty);
    });

    test('non-string entries are skipped without taking the rest with them', () {
      final failure = ComplianceFailure.from(refusal({
        'missing': [42, 'DRIVING_LICENCE', null],
      }),)!;

      expect(failure.missing, [DriverDocumentType.drivingLicence]);
    });
  });

  group('the wire contract', () {
    test('every document type round-trips', () {
      for (final type in DriverDocumentType.values) {
        expect(DriverDocumentType.fromWire(type.wire), type);
      }
    });

    test('the wire names match the server enum in migration 0010', () {
      expect(DriverDocumentType.values.map((t) => t.wire).toSet(), {
        'NATIONAL_ID',
        'DRIVING_LICENCE',
        'VEHICLE_REGISTRATION',
        'VEHICLE_AUTHORIZATION',
      });
    });
  });
}
