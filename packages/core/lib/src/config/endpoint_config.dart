/// Where the app talks to.
///
/// ## Why this is not just a `String.fromEnvironment` with a default
///
/// It was, and the default was `http://10.0.2.2:3000/v1` — the Android
/// emulator's route to the host machine. The comment above it said a release
/// build could not point at localhost. Nothing enforced that, so a release
/// bundle built without `--dart-define=API_BASE_URL` silently shipped aimed at
/// a development server over plaintext HTTP. It installs, it opens, and every
/// request fails with a network error that looks like the user's connection.
///
/// A default that is only correct in development is not a default; it is a
/// trap that springs at the moment nobody is watching. So the rules are
/// checked, and in a release build a missing or unsafe endpoint stops the app
/// at startup with a message naming the flag to pass.
library;

/// The API base URL this binary was built with.
///
/// Defined once, here, so `main` and every screen read the same value.
/// `String.fromEnvironment` must be const, so it cannot be threaded through a
/// function - and two separate declarations with two separate defaults is
/// exactly how one of them ends up stale.
const kApiBaseUrlFromEnv = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://10.0.2.2:3000/v1',
);

/// The realtime socket URL this binary was built with. See [kApiBaseUrlFromEnv].
const kRealtimeUrlFromEnv = String.fromEnvironment(
  'WS_URL',
  defaultValue: 'ws://10.0.2.2:3000/v1/realtime',
);

/// A configuration mistake, surfaced where it can still be fixed.
///
/// Deliberately not an `ApiException`: nothing about this is recoverable at
/// runtime and no retry will help. It is a build that should not have been
/// produced.
class EndpointConfigError implements Exception {
  const EndpointConfigError(this.message);

  final String message;

  @override
  String toString() => 'EndpointConfigError: $message';
}

/// Hosts that can only ever mean "a developer's machine".
///
/// `10.0.2.2` is the Android emulator's alias for the host; `10.0.3.2` is
/// Genymotion's. Neither resolves to anything on a real handset.
const _developmentHosts = {
  'localhost',
  '127.0.0.1',
  '::1',
  '10.0.2.2',
  '10.0.3.2',
};

/// The validated endpoints an app should use.
class EndpointConfig {
  const EndpointConfig({required this.apiBaseUrl, required this.realtimeUrl});

  /// Validate the compile-time configuration.
  ///
  /// [isRelease] is passed in rather than read from `kReleaseMode` here so the
  /// rules can be tested in both modes — a check that cannot be exercised in
  /// the mode it guards is a check nobody has seen work.
  factory EndpointConfig.resolve({
    required String apiBaseUrl,
    required String realtimeUrl,
    required bool isRelease,
  }) {
    if (!isRelease) {
      // Anything goes: a developer pointing at their own machine is the point.
      return EndpointConfig(apiBaseUrl: apiBaseUrl, realtimeUrl: realtimeUrl);
    }

    _require(apiBaseUrl, name: 'API_BASE_URL', secureScheme: 'https');
    _require(realtimeUrl, name: 'REALTIME_URL', secureScheme: 'wss');

    return EndpointConfig(apiBaseUrl: apiBaseUrl, realtimeUrl: realtimeUrl);
  }

  final String apiBaseUrl;
  final String realtimeUrl;

  static void _require(
    String value, {
    required String name,
    required String secureScheme,
  }) {
    if (value.isEmpty) {
      throw EndpointConfigError(
        'A release build needs $name. Pass '
        '--dart-define=$name=$secureScheme://api.example.iq/... at build time.',
      );
    }

    final uri = Uri.tryParse(value);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      throw EndpointConfigError('$name is not a valid URL: $value');
    }

    if (uri.scheme != secureScheme) {
      // Plaintext carries the bearer token in the clear, and Iraqi mobile
      // networks are not a trusted path.
      throw EndpointConfigError(
        '$name must use $secureScheme:// in a release build, not ${uri.scheme}://.',
      );
    }

    if (_developmentHosts.contains(uri.host)) {
      throw EndpointConfigError(
        '$name points at ${uri.host}, which is a development host. '
        'A release build must name the real server.',
      );
    }
  }
}
