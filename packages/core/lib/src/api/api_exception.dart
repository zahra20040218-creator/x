import 'package:dio/dio.dart';

/// The server's RFC 9457 problem types, as an enum.
///
/// The apps switch on THIS, never on a message string. A message is prose that
/// changes; the type is a contract. `rideAlreadyClaimed` in particular drives a
/// specific screen ("الرحلة لم تعد متاحة"), and matching it by text would break
/// the first time the wording improved.
enum ApiProblem {
  validationFailed('validation-failed'),
  unauthorized('unauthorized'),
  forbidden('forbidden'),
  notFound('not-found'),
  conflict('conflict'),
  invalidRideTransition('invalid-ride-transition'),
  rideActorNotPermitted('ride-actor-not-permitted'),
  rideAlreadyClaimed('ride-already-claimed'),
  idempotencyKeyReused('idempotency-key-reused'),
  /// A required driver document is missing, rejected or expired.
  driverNotCompliant('driver-not-compliant'),
  idempotencyInProgress('idempotency-in-progress'),
  notImplemented('not-implemented'),
  serviceUnavailable('service-unavailable'),
  internalError('internal-error'),

  /// No response at all: aeroplane mode, a dead cell, a dropped socket. Very
  /// much the normal case in Baghdad, and handled as such rather than as a
  /// crash.
  network('network'),
  unknown('unknown');

  const ApiProblem(this.slug);

  final String slug;

  static ApiProblem fromType(String? type) {
    if (type == null) return ApiProblem.unknown;
    final slug = type.split('/').last;
    return ApiProblem.values.firstWhere(
      (problem) => problem.slug == slug,
      orElse: () => ApiProblem.unknown,
    );
  }
}

class FieldError {
  const FieldError({required this.path, required this.message});

  final String path;
  final String message;
}

class ApiException implements Exception {
  ApiException({
    required this.problem,
    required this.status,
    this.detail,
    this.errors = const [],
    this.requestId,
    this.extra = const {},
  });

  factory ApiException.from(DioException error) {
    final response = error.response;

    if (response == null) {
      return ApiException(
        problem: ApiProblem.network,
        status: 0,
        detail: error.message,
      );
    }

    final data = response.data;
    if (data is! Map<String, dynamic>) {
      return ApiException(
        problem: ApiProblem.unknown,
        status: response.statusCode ?? 0,
      );
    }

    return ApiException(
      problem: ApiProblem.fromType(data['type'] as String?),
      status: response.statusCode ?? 0,
      detail: data['detail'] as String?,
      requestId: data['requestId'] as String?,
      // The whole decoded body. RFC 9457 lets a problem carry members beyond
      // the standard ones, and some of ours do - driver-not-compliant lists
      // the documents at fault. Dropping them here would leave the app able to
      // say only "you cannot go online".
      extra: data,
      errors: (data['errors'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map(
            (e) => FieldError(
              path: e['path'] as String? ?? '',
              message: e['message'] as String? ?? '',
            ),
          )
          .toList(),
    );
  }

  final ApiProblem problem;
  final int status;
  final String? detail;
  final List<FieldError> errors;
  final String? requestId;

  /// The raw problem body, including any non-standard members. See [extra] use
  /// in `ComplianceFailure`.
  final Map<String, dynamic> extra;

  /// Worth retrying with the SAME idempotency key.
  ///
  /// A network failure and a 503 are both "we do not know whether the server
  /// saw this". `idempotencyInProgress` is explicitly retryable: the server is
  /// still working on the original and wants the client to ask again.
  bool get isRetryable =>
      problem == ApiProblem.network ||
      problem == ApiProblem.serviceUnavailable ||
      problem == ApiProblem.idempotencyInProgress ||
      status >= 500;

  /// The session is gone; the app must route to sign-in.
  bool get requiresReauthentication => problem == ApiProblem.unauthorized;

  @override
  String toString() =>
      'ApiException(${problem.slug}, status: $status, detail: $detail)';
}
