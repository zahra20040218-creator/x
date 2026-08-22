import 'dart:async';

import 'package:dio/dio.dart';
import 'package:rideapp_core/src/api/api_exception.dart';
import 'package:rideapp_core/src/api/token_store.dart';
import 'package:rideapp_core/src/models/models.dart';
import 'package:uuid/uuid.dart';

/// The one way either app talks to the server.
///
/// Three behaviours here are not conveniences — they are the client half of
/// guarantees the server makes:
///
///  * **Idempotency-Key on ride creation** (CLAUDE.md §5.2). The key is
///    generated ONCE per user intent and reused across retries. Generating a
///    fresh key per attempt would defeat the entire mechanism, which is the
///    most likely way to get this wrong.
///
///  * **Single-flight token refresh.** A 401 refreshes and retries. If five
///    requests 401 at once, only ONE refresh runs — the refresh token rotates
///    on use, so five concurrent refreshes would invalidate each other and log
///    the user out mid-ride.
///
///  * **RFC 9457 errors become typed exceptions.** The apps switch on
///    `problem.type`, never on a message string.
class ApiClient {
  ApiClient({
    required String baseUrl,
    required TokenStore tokens,
    Dio? dio,
  })  : _tokens = tokens,
        _dio = dio ?? Dio() {
    _dio.options
      ..baseUrl = baseUrl
      ..connectTimeout = const Duration(seconds: 10)
      // Generous: Baghdad mobile networks are slow before they are absent, and
      // a short timeout turns a slow request into a retry storm.
      ..receiveTimeout = const Duration(seconds: 20)
      ..sendTimeout = const Duration(seconds: 20)
      ..headers['Accept'] = 'application/json'
      ..validateStatus = (status) => status != null && status < 500;

    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await _tokens.accessToken();
          if (token != null) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          options.headers['X-Request-Id'] = _uuid.v4();
          handler.next(options);
        },
        onResponse: (response, handler) {
          final status = response.statusCode ?? 0;
          if (status >= 400) {
            handler.reject(
              DioException(
                requestOptions: response.requestOptions,
                response: response,
                type: DioExceptionType.badResponse,
              ),
            );
            return;
          }
          handler.next(response);
        },
      ),
    );
  }

  final Dio _dio;
  final TokenStore _tokens;
  static const Uuid _uuid = Uuid();

  /// Guards the refresh so concurrent 401s share one rotation.
  Future<bool>? _refreshInFlight;

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  Future<AuthSession> verifyOtp({
    required String firebaseIdToken,
    required UserRole role,
    String? displayName,
  }) async {
    final json = await _send<Map<String, dynamic>>(
      'POST',
      '/auth/otp/verify',
      body: {
        'firebaseIdToken': firebaseIdToken,
        'role': role.wire,
        if (displayName != null) 'displayName': displayName,
      },
      authenticated: false,
    );

    final session = AuthSession.fromJson(json);
    await _tokens.save(
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    );
    return session;
  }

  Future<void> logout() async {
    // Best effort: the server revokes, but a network failure must not leave
    // tokens on the device.
    try {
      await _send<void>('POST', '/auth/logout', expectNoContent: true);
    } on ApiException {
      // Deliberately swallowed - see above. The local clear below is what
      // actually protects the user on a shared or lost handset.
    } finally {
      await _tokens.clear();
    }
  }

  Future<Me> me() async =>
      Me.fromJson(await _send<Map<String, dynamic>>('GET', '/me'));

  Future<Me> updateMe({required String displayName}) async => Me.fromJson(
        await _send<Map<String, dynamic>>(
          'PATCH',
          '/me',
          body: {'displayName': displayName},
        ),
      );

  // ---------------------------------------------------------------------------
  // Rider
  // ---------------------------------------------------------------------------

  Future<FareEstimate> estimateFare({
    required LatLng pickup,
    required LatLng dropoff,
  }) async =>
      FareEstimate.fromJson(
        await _send<Map<String, dynamic>>(
          'POST',
          '/fare/estimate',
          body: {'pickup': pickup.toJson(), 'dropoff': dropoff.toJson()},
        ),
      );

  /// Request a ride.
  ///
  /// [idempotencyKey] MUST be generated once per user intent and reused on every
  /// retry of that same intent (CLAUDE.md §5.2). Callers use
  /// [newIdempotencyKey] when the user taps, and hold it for the whole retry
  /// sequence.
  Future<Ride> createRide({
    required LatLng pickup,
    required LatLng dropoff,
    required String idempotencyKey,
    String? pickupAddress,
    String? dropoffAddress,
  }) async =>
      Ride.fromJson(
        await _send<Map<String, dynamic>>(
          'POST',
          '/rides',
          body: {
            'pickup': pickup.toJson(),
            'dropoff': dropoff.toJson(),
            if (pickupAddress != null) 'pickupAddress': pickupAddress,
            if (dropoffAddress != null) 'dropoffAddress': dropoffAddress,
          },
          headers: {'Idempotency-Key': idempotencyKey},
        ),
      );

  /// One key per user intent, not per attempt.
  static String newIdempotencyKey() => _uuid.v4();

  Future<List<Ride>> myRides({int limit = 20, RideStatus? status}) async {
    final json = await _send<Map<String, dynamic>>(
      'GET',
      '/rides/me',
      query: {'limit': limit, if (status != null) 'status': status.wire},
    );
    return (json['items'] as List<dynamic>)
        .map((item) => Ride.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  Future<Ride> getRide(String rideId) async =>
      Ride.fromJson(await _send<Map<String, dynamic>>('GET', '/rides/$rideId'));

  Future<Ride> cancelRide(String rideId, {String? reason}) async =>
      Ride.fromJson(
        await _send<Map<String, dynamic>>(
          'POST',
          '/rides/$rideId/cancel',
          body: {if (reason != null) 'reason': reason},
        ),
      );

  Future<void> rateRide(
    String rideId, {
    required int score,
    String? comment,
  }) async =>
      _send<Map<String, dynamic>>(
        'POST',
        '/rides/$rideId/rate',
        body: {'score': score, if (comment != null) 'comment': comment},
      );

  // ---------------------------------------------------------------------------
  // Driver
  // ---------------------------------------------------------------------------

  Future<void> setAvailability({
    required DriverAvailability availability,
    LatLng? position,
  }) async =>
      _send<Map<String, dynamic>>(
        'PUT',
        '/driver/availability',
        body: {
          'availability': availability.wire,
          if (position != null) 'position': position.toJson(),
        },
      );

  /// Upload a BATCH of buffered samples (CLAUDE.md §5.3).
  ///
  /// The server keeps only the newest as the live position and writes the rest
  /// to history, so flushing a long offline buffer does not make the driver
  /// appear to jump backwards on the rider's map.
  Future<int> reportLocations(List<LocationSample> samples) async {
    if (samples.isEmpty) return 0;
    final json = await _send<Map<String, dynamic>>(
      'POST',
      '/driver/location',
      body: {'samples': samples.map((s) => s.toJson()).toList()},
    );
    return json['accepted'] as int? ?? 0;
  }

  /// The polling fallback for when push never arrived. Returns null on 204.
  Future<RideOffer?> currentOffer() async {
    final json = await _send<Map<String, dynamic>?>(
      'GET',
      '/driver/offers/current',
      allowEmpty: true,
    );
    return json == null ? null : RideOffer.fromJson(json);
  }

  Future<Ride> acceptRide(String rideId) async => Ride.fromJson(
        await _send<Map<String, dynamic>>('POST', '/rides/$rideId/accept'),
      );

  Future<void> declineRide(String rideId) async =>
      _send<void>('POST', '/rides/$rideId/decline', expectNoContent: true);

  Future<Ride> markArrived(String rideId) async => Ride.fromJson(
        await _send<Map<String, dynamic>>('POST', '/rides/$rideId/arrived'),
      );

  Future<Ride> startRide(String rideId) async => Ride.fromJson(
        await _send<Map<String, dynamic>>('POST', '/rides/$rideId/start'),
      );

  Future<Ride> completeRide(String rideId, {int? actualDistanceM}) async {
    final json = await _send<Map<String, dynamic>>(
      'POST',
      '/rides/$rideId/complete',
      body: {if (actualDistanceM != null) 'actualDistanceM': actualDistanceM},
    );
    return Ride.fromJson(json['ride'] as Map<String, dynamic>);
  }

  Future<WalletBalance> wallet() async => WalletBalance.fromJson(
        await _send<Map<String, dynamic>>('GET', '/driver/wallet'),
      );

  // ---------------------------------------------------------------------------

  /// Send a request, refreshing once on 401.
  Future<T> _send<T>(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, dynamic>? query,
    Map<String, String>? headers,
    bool authenticated = true,
    bool expectNoContent = false,
    bool allowEmpty = false,
  }) async {
    try {
      return _unwrap<T>(
        await _dio.request<dynamic>(
          path,
          data: body,
          queryParameters: query,
          options: Options(method: method, headers: headers),
        ),
        expectNoContent: expectNoContent,
        allowEmpty: allowEmpty,
      );
    } on DioException catch (error) {
      final status = error.response?.statusCode;

      if (status == 401 && authenticated && await _refreshOnce()) {
        // Retried ONCE. A loop here would hammer the server with a token it
        // already rejected.
        try {
          return _unwrap<T>(
            await _dio.request<dynamic>(
              path,
              data: body,
              queryParameters: query,
              options: Options(method: method, headers: headers),
            ),
            expectNoContent: expectNoContent,
            allowEmpty: allowEmpty,
          );
        } on DioException catch (retryError) {
          throw ApiException.from(retryError);
        }
      }

      throw ApiException.from(error);
    }
  }

  T _unwrap<T>(
    Response<dynamic> response, {
    required bool expectNoContent,
    required bool allowEmpty,
  }) {
    if (expectNoContent || response.statusCode == 204) {
      return null as T;
    }
    if (allowEmpty && (response.data == null || response.data == '')) {
      return null as T;
    }
    return response.data as T;
  }

  /// Refresh, at most one at a time.
  ///
  /// The refresh token rotates on use, so concurrent refreshes would each
  /// invalidate the others and sign the user out — during a ride, on a bad
  /// connection, which is exactly when several requests 401 together.
  Future<bool> _refreshOnce() {
    return _refreshInFlight ??= _doRefresh().whenComplete(() {
      _refreshInFlight = null;
    });
  }

  Future<bool> _doRefresh() async {
    final refreshToken = await _tokens.refreshToken();
    if (refreshToken == null) return false;

    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/auth/refresh',
        data: {'refreshToken': refreshToken},
        options: Options(headers: {'Authorization': null}),
      );
      final session = AuthSession.fromJson(response.data!);
      await _tokens.save(
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      );
      return true;
    } on DioException {
      // The refresh token is spent or revoked. Clear everything so the app
      // routes to sign-in rather than retrying with a dead token forever.
      await _tokens.clear();
      return false;
    }
  }
}
