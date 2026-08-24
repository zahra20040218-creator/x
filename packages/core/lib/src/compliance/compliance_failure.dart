import 'package:rideapp_core/src/api/api_exception.dart';

/// A driver document the platform can require.
///
/// Wire values match the server enum in migration 0010. Closed rather than a
/// free string so a name the server would not recognise cannot be constructed.
enum DriverDocumentType {
  nationalId('NATIONAL_ID'),
  drivingLicence('DRIVING_LICENCE'),
  vehicleRegistration('VEHICLE_REGISTRATION'),
  vehicleAuthorization('VEHICLE_AUTHORIZATION');

  const DriverDocumentType(this.wire);

  final String wire;

  /// Null for a name this build does not know.
  ///
  /// Returns null rather than falling back to a member: a document type added
  /// on the server after this build shipped is not any of the ones here, and
  /// showing the driver the wrong document to fetch wastes a trip to a
  /// government office.
  static DriverDocumentType? fromWire(String value) {
    for (final type in DriverDocumentType.values) {
      if (type.wire == value) return type;
    }
    return null;
  }
}

/// Why the server refused to bring a driver online.
///
/// Parsed from the `driver-not-compliant` problem, which lists the documents at
/// fault as codes. The server never sends prose: it does not know the driver's
/// language, and a translated sentence from an API is wrong the moment someone
/// opens the app in English (CLAUDE.md §8).
///
/// The three lists are separate because they send the driver to different
/// places. Missing means bring it in. Expired means renew it first. Rejected
/// means the same document will not do, and bringing it again wastes the trip.
class ComplianceFailure {
  const ComplianceFailure({
    required this.missing,
    required this.expired,
    required this.rejected,
    required this.unknown,
  });

  /// Null when [error] is not a compliance refusal.
  static ComplianceFailure? from(ApiException error) {
    if (error.problem != ApiProblem.driverNotCompliant) return null;

    final unknown = <String>[];

    List<DriverDocumentType> read(String key) {
      final raw = error.extra[key];
      if (raw is! List) return const [];

      final types = <DriverDocumentType>[];
      for (final entry in raw) {
        if (entry is! String) continue;
        final type = DriverDocumentType.fromWire(entry);
        if (type == null) {
          unknown.add(entry);
        } else {
          types.add(type);
        }
      }
      return types;
    }

    return ComplianceFailure(
      missing: read('missing'),
      expired: read('expired'),
      rejected: read('rejected'),
      unknown: List.unmodifiable(unknown),
    );
  }

  final List<DriverDocumentType> missing;
  final List<DriverDocumentType> expired;
  final List<DriverDocumentType> rejected;

  /// Document codes this build does not recognise, kept so the driver is told
  /// *something* rather than shown an empty reason.
  final List<String> unknown;

  /// True when the server refused but named nothing this build understands.
  ///
  /// Possible after a server-side deployment adds a document type. The app must
  /// still say why the driver cannot work, even if it cannot name the document.
  bool get isUnexplained =>
      missing.isEmpty && expired.isEmpty && rejected.isEmpty;
}
