import 'dart:async';

import '../api/api_client.dart';
import '../api/api_exception.dart';

/// Why a device is not receiving notifications.
///
/// Each value maps to a different fix, which is the whole reason they are
/// separate. "Notifications are off" is not actionable; "you denied the
/// permission" and "this build has no Firebase configuration" are.
enum PushStatus {
  /// Registered with the server. Offers will arrive.
  registered,

  /// The user refused the notification permission.
  permissionDenied,

  /// The build has no Firebase configuration, so no token can exist.
  notConfigured,

  /// A token was obtained but the server rejected or never saw it.
  registrationFailed,

  /// Not attempted yet.
  unknown,
}

/// Where an FCM token comes from.
///
/// An interface because `firebase_messaging` needs a platform channel and
/// cannot run in a unit test, while the *sequence* — ask permission, get a
/// token, register it, re-register when it rotates — is ordinary logic that
/// must be testable. Every failure branch below is covered by a fake.
abstract interface class PushTokenSource {
  /// False when the app was built without Firebase configuration.
  bool get isConfigured;

  /// Ask the OS. Android 13+ requires this at runtime.
  Future<bool> requestPermission();

  /// Null when no token can be issued.
  Future<String?> getToken();

  /// FCM rotates tokens — on reinstall, on data clear, and periodically.
  Stream<String> get onTokenRefresh;
}

/// Keeps the server's idea of this device in step with FCM's.
///
/// ## Why this exists as a class rather than three lines in `main`
///
/// A token that is fetched once at startup goes stale silently. FCM reissues
/// tokens, and the app that does not listen keeps a registration pointing at
/// an address that no longer exists — the driver's phone simply stops ringing,
/// with nothing in any log to say so. The refresh subscription is the point.
class PushRegistrar {
  PushRegistrar({required ApiClient api, required PushTokenSource source})
      : _api = api,
        _source = source;

  final ApiClient _api;
  final PushTokenSource _source;

  StreamSubscription<String>? _refreshSubscription;
  String? _registeredToken;
  PushStatus _status = PushStatus.unknown;

  PushStatus get status => _status;

  /// The token currently registered with the server, if any.
  String? get registeredToken => _registeredToken;

  /// Call after sign-in.
  ///
  /// Never throws. A notification problem must not stop someone using the app
  /// — a driver with no push can still work with the app in the foreground,
  /// and a rider needs none of it to request a ride.
  Future<PushStatus> start() async {
    if (!_source.isConfigured) {
      _status = PushStatus.notConfigured;
      return _status;
    }

    final granted = await _source.requestPermission();
    if (!granted) {
      _status = PushStatus.permissionDenied;
      return _status;
    }

    final token = await _source.getToken();
    if (token == null || token.isEmpty) {
      _status = PushStatus.registrationFailed;
      return _status;
    }

    _status = await _register(token);

    // Subscribed AFTER the first registration, and only once. Re-subscribing
    // on every start would deliver each rotation several times and register
    // the same token repeatedly.
    _refreshSubscription ??= _source.onTokenRefresh.listen((refreshed) {
      unawaited(_register(refreshed));
    });

    return _status;
  }

  Future<PushStatus> _register(String token) async {
    // FCM re-emits the same token on some platforms. Registering it again is
    // harmless server-side (the endpoint is idempotent) but pointless, and it
    // burns a CRITICAL-tier rate-limit slot on every app launch.
    if (token == _registeredToken) return _status;

    try {
      await _api.registerDevice(token: token);
      _registeredToken = token;
      _status = PushStatus.registered;
    } on ApiException {
      // Swallowed deliberately. The caller is a `listen` callback or an
      // app-start path; neither has anywhere useful to put an exception, and
      // the status field is how the UI learns about it.
      _status = PushStatus.registrationFailed;
    }
    return _status;
  }

  /// Call on sign-out, BEFORE the session is revoked.
  ///
  /// Order matters: `DELETE /devices` is authenticated, so once the session is
  /// gone the request can only 401 and the device stays registered — and the
  /// next driver to sign in on that handset would receive the previous
  /// driver's ride offers.
  Future<void> stop() async {
    await _refreshSubscription?.cancel();
    _refreshSubscription = null;

    final token = _registeredToken;
    _registeredToken = null;
    _status = PushStatus.unknown;

    if (token == null) return;

    try {
      await _api.unregisterDevice(token);
    } on ApiException {
      // Best effort. A network failure must not block sign-out and strand the
      // user in a session they asked to end; the server-side session
      // revocation is what actually matters, and a stale device row stops
      // being delivered to once FCM reports the token invalid.
    }
  }

  /// Release the subscription without touching the server.
  Future<void> dispose() async {
    await _refreshSubscription?.cancel();
    _refreshSubscription = null;
  }
}
