import 'dart:async';

import 'package:dio/dio.dart';
import 'package:rideapp_core/src/api/api_exception.dart';
import 'package:rideapp_core/src/api/token_store.dart';
import 'package:rideapp_core/src/models/models.dart';
import 'package:rideapp_core/src/money/iqd.dart';
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
    int? proposedFareIqd,
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
            // Supplying this is what opens the ride to driver bids. Ignored by
            // the server unless `negotiation_enabled` is on, so sending it
            // against a platform with negotiation off behaves exactly as a
            // metered request does.
            if (proposedFareIqd != null) 'proposedFareIqd': proposedFareIqd,
          },
          headers: {'Idempotency-Key': idempotencyKey},
        ),
      );

  // ---------------------------------------------------------------------------
  // Fare negotiation.
  //
  // These endpoints have existed since migration 0012 and no Dart client knew
  // them, which is why the feature was unreachable from the app.
  //
  // All four answer 404 when `platform_config.negotiation_enabled` is off, and
  // there is no endpoint that reports the flag. So a 404 here means "this
  // platform does not negotiate", NOT "something is missing" — callers fall
  // back to metered dispatch, which is what the contract describes.
  // ---------------------------------------------------------------------------

  /// The bids on the caller's own ride, cheapest first.
  ///
  /// Rider-only, and only their own ride: a driver reading this would learn
  /// what their competitors offered.
  Future<RideBidsPage> rideBids(String rideId) async {
    final json = await _send<Map<String, dynamic>>(
      'GET',
      '/rides/$rideId/bids',
    );

    return RideBidsPage(
      proposedFareIqd: IqdAmount.fromJson(json['proposedFareIqd']),
      bids: (json['bids'] as List<dynamic>? ?? const [])
          .map((e) => RideBid.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  /// Bid on a ride, or replace this driver's existing bid.
  ///
  /// A driver has at most ONE active bid per ride, enforced by a partial
  /// unique index. Bidding again supersedes the previous bid rather than
  /// editing it.
  Future<RideBid> placeBid(
    String rideId, {
    required int amountIqd,
    int? etaSeconds,
  }) async =>
      RideBid.fromJson(
        await _send<Map<String, dynamic>>(
          'POST',
          '/rides/$rideId/bids',
          body: {
            'amountIqd': amountIqd,
            if (etaSeconds != null) 'etaSeconds': etaSeconds,
          },
        ),
      );

  /// The rider selects a bid; the ride is assigned at that fare.
  ///
  /// 409 when that driver has since taken another ride — the claim (§5.1) is
  /// what decides, exactly as it does for metered dispatch.
  Future<Ride> acceptBid(String rideId, String bidId) async => Ride.fromJson(
        await _send<Map<String, dynamic>>(
          'POST',
          '/rides/$rideId/bids/$bidId/accept',
        ),
      );

  /// Open ride requests this driver may bid on, nearest first.
  ///
  /// Scoped server-side by the driver's Redis position and the configured
  /// radius. 403 — not an empty list — when the account may not drive, so the
  /// app can say why (CLAUDE.md §1.1).
  Future<List<OpenRideRequest>> openRideRequests() async {
    final json = await _send<Map<String, dynamic>>(
      'GET',
      '/driver/ride-requests',
    );

    return (json['requests'] as List<dynamic>? ?? const [])
        .map((e) => OpenRideRequest.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// One key per user intent, not per attempt.
  static String newIdempotencyKey() => _uuid.v4();

  /// The current access token, for the realtime handshake.
  ///
  /// The WebSocket cannot carry an Authorization header, so the token goes in
  /// the first frame instead. Exposed here rather than letting screens reach
  /// into the token store directly, so storage stays a single concern.
  Future<String?> currentAccessToken() => _tokens.accessToken();

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

  /// One page of the driver's ledger, newest first.
  ///
  /// Returns BOTH sides of every transaction, exactly as the server stores
  /// them. Summing `amountIqd` here would double-count; sum `signedIqd`.
  ///
  /// `cursor` is opaque — the value the previous page returned as
  /// `nextCursor`, and nothing else. It used to be built here from a
  /// `DateTime`, which silently lost entries: `timestamptz` is microsecond
  /// precision and a Dart `DateTime` sent as ISO-8601 is not, so the value
  /// never matched the row it came from. The server resolves the position
  /// itself now. See services/api/src/http/cursor.ts.
  Future<LedgerPage> walletEntries({int limit = 50, String? cursor}) async {
    final json = await _send<Map<String, dynamic>>(
      'GET',
      '/driver/wallet/entries',
      query: {
        'limit': limit,
        if (cursor != null) 'cursor': cursor,
      },
    );
    return LedgerPage(
      items: (json['items'] as List<dynamic>)
          .map((item) => LedgerEntry.fromJson(item as Map<String, dynamic>))
          .toList(),
      nextCursor: json['nextCursor'] as String?,
    );
  }

  /// Register this device for push notifications.
  ///
  /// Idempotent by token: the apps call it on every launch, because FCM
  /// reissues tokens on reinstall and after a data clear. A device that is
  /// never registered silently receives no ride offers at all, which is
  /// indistinguishable from there being no demand.
  /// Open a dispute on a ride.
  ///
  /// Available to the rider and the driver on rides they were part of; the
  /// server answers 404 rather than 403 for anyone else, so that the endpoint
  /// cannot be used to discover which ride ids exist.
  ///
  /// The path is `/admin/disputes` because that is where the collection lives
  /// in the contract — the POST itself is deliberately not admin-only.
  Future<Dispute> openDispute({
    required String rideId,
    required DisputeReason reason,
    String? description,
  }) async =>
      Dispute.fromJson(
        await _send<Map<String, dynamic>>(
          'POST',
          '/admin/disputes',
          body: {
            'rideId': rideId,
            'reasonCode': reason.wire,
            if (description != null && description.isNotEmpty)
              'description': description,
          },
        ),
      );

  Future<void> registerDevice({
    required String token,
    String platform = 'ANDROID',
  }) async {
    await _send<void>(
      'POST',
      '/devices',
      body: {'token': token, 'platform': platform},
      expectNoContent: true,
    );
  }

  /// Stop delivering to this device. Called on sign-out.
  ///
  /// Without it a driver who logs out keeps receiving ride offers on a phone
  /// they are no longer working from.
  Future<void> unregisterDevice(String token) async {
    await _send<void>(
      'DELETE',
      '/devices',
      body: {'token': token},
      expectNoContent: true,
    );
  }

  Future<WalletBalance> wallet() async => WalletBalance.fromJson(
        await _send<Map<String, dynamic>>('GET', '/driver/wallet'),
      );

  /// Erase this account, at the user's own request.
  ///
  /// Google Play requires an in-app path to account deletion. It anonymises
  /// rather than deletes - the money and the audit trail survive, pointing at
  /// an anonymous id - and `docs/PLAY_LISTING.md` discloses exactly that.
  ///
  /// Throws `ApiProblem.conflict` when a ride is in progress, with `rideId` in
  /// the problem body so the caller can offer to open it. Idempotent
  /// otherwise: a retry after a dropped response succeeds rather than failing.
  ///
  /// The caller MUST clear the local session afterwards. Every token for this
  /// account is revoked server-side by the time this returns, so a client that
  /// keeps using its stored one will simply start getting 401s.
  Future<void> deleteAccount() async {
    await _send<void>('POST', '/me/delete', expectNoContent: true);

    // Cleared only on success, and NOT in a `finally`.
    //
    // `logout` swallows its error and clears anyway, because the local clear is
    // what protects a user on a shared handset. This is the opposite case: a
    // 409 means the account still exists and still has a ride in progress, and
    // wiping the session then would strand the user signed out of an account
    // they were told was not deleted, mid-trip.
    await _tokens.clear();
  }

  /// What this account may do, decided on the server (CLAUDE.md §1.1).
  ///
  /// Called on sign-in and whenever a driver-scoped action is refused, so the
  /// app can render the reason instead of a generic error. Nothing in the tree
  /// called this endpoint before, which meant `SUBSCRIPTION_REQUIRED` — and
  /// every other blocker — could never reach a screen.
  ///
  /// Not cached here. This is an authorisation answer, and a cached one is a
  /// stale one: a driver whose subscription was just activated must see the
  /// change on their next look, not after a TTL.
  Future<Capabilities> capabilities() async => Capabilities.fromJson(
        await _send<Map<String, dynamic>>('GET', '/me/capabilities'),
      );

  /// Plans the driver may buy. Active only, cheapest first.
  Future<List<SubscriptionPlan>> subscriptionPlans() async {
    final json = await _send<Map<String, dynamic>>('GET', '/driver/subscription/plans');
    final plans = json['plans'] as List<dynamic>? ?? const [];
    return plans
        .map((e) => SubscriptionPlan.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// The caller's live subscription, or null when they have none.
  ///
  /// Null is a normal answer, not an error: subscriptions are off by default
  /// (`subscription_required` ships false), so most drivers have none and the
  /// screen must read as "not subscribed", never as "something went wrong".
  Future<DriverSubscription?> mySubscription() async {
    final json = await _send<Map<String, dynamic>?>('GET', '/driver/subscription');
    if (json == null || json.isEmpty) return null;
    return DriverSubscription.fromJson(json);
  }

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
