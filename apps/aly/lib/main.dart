import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:path_provider/path_provider.dart';
import 'package:rideapp_aly/location/file_buffer_storage.dart';
import 'package:rideapp_aly/location/location_service.dart';
import 'package:rideapp_aly/screens/battery_exemption_screen.dart';
import 'package:rideapp_aly/screens/home_screen.dart';
import 'package:rideapp_aly/screens/request_ride_screen.dart';
import 'package:rideapp_aly/screens/sign_in_screen.dart';
import 'package:rideapp_aly/screens/subscription_screen.dart';
import 'package:rideapp_aly/screens/track_ride_screen.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// ALY. One app, a Rider mode and a Driver mode (CLAUDE.md §1.1).
///
/// Android only in v1 (§2 — no iOS builds; no `ios/` directory has ever been
/// generated in this repository).
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Without this, every call to `FirebaseAuth.instance` throws
  //   [core/no-app] No Firebase App '[DEFAULT]' has been created
  // and sign-in fails on a real device.
  //
  // No `options:` argument on purpose: on Android the google-services Gradle
  // plugin reads `android/app/google-services.json` and initialises from
  // resources.
  await Firebase.initializeApp();

  // Validated before anything else runs. A release build with no
  // --dart-define=API_BASE_URL used to fall back to the emulator's loopback
  // over plaintext HTTP: it installs, it opens, and every request fails with
  // something that looks like the user's connection.
  //
  // Caught rather than allowed to propagate: an uncaught throw here is an
  // Android launch crash, which gives whoever has to diagnose it nothing.
  final EndpointConfig endpoints;
  try {
    endpoints = EndpointConfig.resolve(
      apiBaseUrl: kApiBaseUrlFromEnv,
      realtimeUrl: kRealtimeUrlFromEnv,
      isRelease: kReleaseMode,
    );
  } on EndpointConfigError catch (error) {
    runApp(MisconfiguredApp(detail: error.message));
    return;
  }

  final tokens = SecureTokenStore();
  final api = ApiClient(baseUrl: endpoints.apiBaseUrl, tokens: tokens);

  // Created eagerly because it needs an await, and lazily initialising it
  // inside a build would put disk I/O on the first frame. It costs one small
  // file read for a rider who will never use it, which is cheaper than the
  // alternative of a FutureBuilder wrapped around the whole app.
  final directory = await getApplicationSupportDirectory();
  final buffer = LocationBuffer(
    storage: FileBufferStorage('${directory.path}/location_buffer.json'),
  );

  runApp(AlyApp(api: api, tokens: tokens, buffer: buffer));
}

/// Which mode the app is showing.
///
/// Not a user preference and not a toggle. CLAUDE.md §1.1: "The mode is a
/// server decision, never a client flag" and "hiding a button is not
/// authorisation". This enum only records what the SERVER last said.
enum AppMode { rider, driver }

class AlyApp extends StatefulWidget {
  const AlyApp({
    required this.api,
    required this.tokens,
    required this.buffer,
    super.key,
  });

  final ApiClient api;
  final TokenStore tokens;
  final LocationBuffer buffer;

  @override
  State<AlyApp> createState() => _AlyAppState();
}

class _AlyAppState extends State<AlyApp> {
  bool _signedIn = false;
  bool _checking = true;

  /// The server's answer, or null when it could not be reached.
  ///
  /// Null is NOT "no driver". The two are kept apart deliberately — see
  /// [_mode].
  Capabilities? _capabilities;

  AppMode _mode = AppMode.rider;
  Ride? _activeRide;
  bool _permissionsDone = false;
  DriverLocationService? _location;

  /// Set with `--dart-define=FIREBASE_CONFIGURED=true` on any build that also
  /// ships `google-services.json`. False by default so an unconfigured build
  /// reports `notConfigured` instead of prompting for a notification
  /// permission that can never produce a working registration.
  static const bool _firebaseConfigured =
      bool.fromEnvironment('FIREBASE_CONFIGURED');

  PushRegistrar? _push;

  void _startPush() {
    _push ??= PushRegistrar(
      api: widget.api,
      source: const FirebasePushTokenSource(isConfigured: _firebaseConfigured),
    );
    unawaited(_push!.start());
  }

  /// BEFORE the session is revoked — `DELETE /devices` is authenticated, so
  /// once the token is gone the device stays registered and the next person to
  /// sign in on this handset would receive the previous user's offers.
  Future<void> _stopPush() async {
    await _push?.stop();
  }

  @override
  void initState() {
    super.initState();
    unawaited(_restore());
  }

  Future<void> _restore() async {
    final token = await widget.tokens.accessToken();

    if (token != null) {
      await _loadCapabilities();

      // Only in rider mode. A driver's live work arrives over the socket and
      // through `/driver/offers/current`; fetching a rider ride history for
      // them would be a wasted round trip on every cold start.
      if (_mode == AppMode.rider) {
        try {
          // A rider who force-quit mid-ride must come back INTO that ride, not
          // to a fresh "where to?" screen with a driver already on the way.
          final rides = await widget.api.myRides(limit: 5);
          _activeRide = rides.where((r) => r.status.isActive).firstOrNull;
        } on ApiException {
          // Offline at launch. The request screen still opens; the ride will
          // be picked up on the next successful call.
        }
      }
    }

    if (!mounted) return;
    setState(() {
      _signedIn = token != null;
      // A returning user never passes through onSignedIn, so without this
      // their device would only ever be registered on first install.
      if (token != null) _startPush();
      _checking = false;
    });
  }

  /// Ask the server what this account may do, and pick the mode from it.
  ///
  /// ## Why a failure does not fall back to Rider mode
  ///
  /// A driver in a basement with no signal would otherwise open the app and be
  /// shown a passenger's "where to?" screen. They are not a passenger; they are
  /// a driver whose network is down, and silently demoting them is the failure
  /// this method is written to avoid.
  ///
  /// So on failure the LAST KNOWN answer is kept, and only a first-ever launch
  /// with no answer at all lands in Rider mode — which is correct, because a
  /// brand-new install with no server contact has no evidence of anything else.
  ///
  /// This never grants driver mode on its own. Every driver-scoped endpoint
  /// re-checks on the server (`CapabilityService.requireDriver`), so the worst
  /// a stale `true` can do is show a screen whose actions are then refused with
  /// a reason the app can now render.
  Future<void> _loadCapabilities() async {
    try {
      final capabilities = await widget.api.capabilities();
      if (!mounted) return;
      setState(() {
        _capabilities = capabilities;
        // Mode follows whether this account IS a driver, NOT whether it may
        // drive right now.
        //
        // `allowed` is false for a driver whose subscription lapsed, whose
        // documents expired, or who was suspended. Choosing the mode from it
        // would silently show those drivers a passenger's "where to?" screen -
        // demoting a person mid-livelihood and telling them nothing. They are
        // drivers with a problem to fix, and Driver mode is where the fix is
        // explained.
        //
        // `NOT_A_DRIVER` is the only blocker that means "this account has no
        // driver row at all", which is the genuine rider case.
        _mode = capabilities.driver.blockers.contains('NOT_A_DRIVER')
            ? AppMode.rider
            : AppMode.driver;
      });
    } on ApiException {
      // Keep whatever the server last said. `_mode` defaults to rider only for
      // an account that has never had an answer.
    }
  }

  Future<DriverLocationService> _ensureLocationService(AppStrings strings) async {
    var service = _location;
    if (service != null) return service;

    service = DriverLocationService(
      api: widget.api,
      buffer: widget.buffer,
      strings: strings,
    );
    await service.init();
    _location = service;
    return service;
  }

  Future<void> _handleSignedOut() async {
    await _stopPush();
    if (!mounted) return;
    setState(() {
      _signedIn = false;
      _activeRide = null;
      // Cleared with the session. Leaving them would let the next person to
      // sign in on this handset land straight in the previous user's mode.
      _capabilities = null;
      _mode = AppMode.rider;
      _permissionsDone = false;
      _location = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      onGenerateTitle: (context) => AppStrings.of(context).appNameRider,
      theme: AppTheme.light(),
      // CLAUDE.md §8 - Arabic primary, RTL.
      locale: const Locale('ar'),
      supportedLocales: const [Locale('ar'), Locale('en')],
      localizationsDelegates: const [
        AppStringsDelegate(),
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      builder: (context, child) => Directionality(
        textDirection: AppStrings.of(context).languageCode == 'en'
            ? TextDirection.ltr
            : TextDirection.rtl,
        child: child ?? const SizedBox.shrink(),
      ),
      home: Builder(builder: _home),
    );
  }

  Widget _home(BuildContext context) {
    if (_checking) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    if (!_signedIn) {
      return SignInScreen(
        api: widget.api,
        onSignedIn: () async {
          // Capabilities BEFORE the first screen, so a driver never sees a
          // passenger's home screen even for one frame.
          await _loadCapabilities();
          if (!mounted) return;
          setState(() => _signedIn = true);
          _startPush();
        },
      );
    }

    return switch (_mode) {
      AppMode.driver => _driverHome(context),
      AppMode.rider => _riderHome(context),
    };
  }

  Widget _driverHome(BuildContext context) {
    // Blocked, but still a driver. Show WHY, and nothing else.
    //
    // Rendering the home screen and letting them discover it by tapping the
    // online switch would be the "hiding a button is not authorisation"
    // mistake in reverse: the server WILL refuse, and the app already knows
    // the reason. `AlyBlockerList` turns the server's codes into a checklist
    // in the driver's own language.
    //
    // This is a screen, not a gate. Every driver-scoped endpoint re-checks on
    // the server, so showing it is never what keeps a blocked driver out.
    final capability = _capabilities?.driver;
    if (capability != null && !capability.allowed) {
      return _BlockedDriverScreen(
        api: widget.api,
        blockers: capability.blockers,
        suspendedReason: capability.suspendedReason,
        onRecheck: _loadCapabilities,
        onSignedOut: () => unawaited(_handleSignedOut()),
      );
    }

    // CLAUDE.md §5.3 - the permission and Doze-exemption flow runs at
    // onboarding, BEFORE the driver can go online. A driver who reaches the
    // online switch without it will silently stop reporting minutes after
    // their screen goes off.
    if (!_permissionsDone) {
      return BatteryExemptionScreen(
        onComplete: () => setState(() => _permissionsDone = true),
      );
    }

    return FutureBuilder<DriverLocationService>(
      future: _ensureLocationService(AppStrings.of(context)),
      builder: (context, snapshot) {
        final service = snapshot.data;
        if (service == null) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          );
        }
        return DriverHomeScreen(
          api: widget.api,
          location: service,
          onSignedOut: () => unawaited(_handleSignedOut()),
        );
      },
    );
  }

  Widget _riderHome(BuildContext context) {
    final active = _activeRide;
    if (active != null) {
      return TrackRideScreen(api: widget.api, ride: active);
    }

    return RequestRideScreen(
      api: widget.api,
      onSignedOut: () => unawaited(_handleSignedOut()),
    );
  }
}


/// Why this driver cannot work, and what to do about each reason.
///
/// Deliberately minimal: a checklist, a retry, and a way out. Anything more
/// would be a second home screen for an account that cannot use one.
class _BlockedDriverScreen extends StatelessWidget {
  const _BlockedDriverScreen({
    required this.api,
    required this.blockers,
    required this.suspendedReason,
    required this.onRecheck,
    required this.onSignedOut,
  });

  final ApiClient api;
  final List<String> blockers;
  final String? suspendedReason;
  final Future<void> Function() onRecheck;
  final VoidCallback onSignedOut;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(strings.appNameDriver),
        actions: [
          IconButton(
            tooltip: strings.signOut,
            icon: const Icon(Icons.logout),
            onPressed: onSignedOut,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: onRecheck,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            AlyBlockerList(
              codes: blockers,
              onAction: (code) {
                // The one blocker the driver can act on inside the app. The
                // rest route to support, which is not something a button can
                // do for them.
                if (code == 'SUBSCRIPTION_REQUIRED') {
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => SubscriptionScreen(api: api),
                    ),
                  );
                }
              },
            ),
            if (suspendedReason != null && suspendedReason!.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.md),
              // The operator's own words. It is the only part of this screen
              // the driver could not have predicted.
              Text(suspendedReason!, style: Theme.of(context).textTheme.bodyMedium),
            ],
          ],
        ),
      ),
    );
  }
}
