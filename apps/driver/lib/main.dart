import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:path_provider/path_provider.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:rideapp_driver/location/file_buffer_storage.dart';
import 'package:rideapp_driver/location/location_service.dart';
import 'package:rideapp_driver/screens/battery_exemption_screen.dart';
import 'package:rideapp_driver/screens/home_screen.dart';
import 'package:rideapp_driver/screens/sign_in_screen.dart';

/// Driver app entry point. Android only in v1 (CLAUDE.md §2 — no iOS builds).
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Without this, every call to `FirebaseAuth.instance` throws
  //   [core/no-app] No Firebase App '[DEFAULT]' has been created
  // and sign-in fails on a real device for both apps. It was missing.
  //
  // No `options:` argument on purpose: on Android the google-services Gradle
  // plugin reads `android/app/google-services.json` and initialises from
  // resources. That file is NOT in this repository and must not be - it is
  // per-project configuration, and CLAUDE.md §9 forbids committed config.
  // Until it is supplied the app will fail HERE, at startup, with a clear
  // message, instead of failing later and less clearly at the sign-in screen.
  await Firebase.initializeApp();

  // Validated before anything else runs. A release build with no
  // --dart-define=API_BASE_URL used to fall back to the emulator's loopback
  // over plaintext HTTP: it installs, it opens, and every request fails with
  // something that looks like the user's connection. See EndpointConfig.
  //
  // Caught rather than allowed to propagate: an uncaught throw here is an
  // Android launch crash, which gives whoever has to diagnose it nothing at
  // all. This way the bundle says what is wrong with it.
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

  final directory = await getApplicationSupportDirectory();
  final buffer = LocationBuffer(
    storage: FileBufferStorage('${directory.path}/location_buffer.json'),
  );

  runApp(DriverApp(api: api, tokens: tokens, buffer: buffer));
}

class DriverApp extends StatefulWidget {
  const DriverApp({
    required this.api,
    required this.tokens,
    required this.buffer,
    super.key,
  });

  final ApiClient api;
  final TokenStore tokens;
  final LocationBuffer buffer;

  @override
  State<DriverApp> createState() => _DriverAppState();
}

class _DriverAppState extends State<DriverApp> {
  DriverLocationService? _location;
  bool _signedIn = false;
  bool _permissionsDone = false;
  bool _checking = true;


  /// Set with `--dart-define=FIREBASE_CONFIGURED=true` on any build that also
  /// ships `google-services.json`. False by default so an unconfigured build
  /// reports `notConfigured` instead of prompting for a notification
  /// permission that can never produce a working registration.
  static const bool _firebaseConfigured =
      bool.fromEnvironment('FIREBASE_CONFIGURED');

  PushRegistrar? _push;

  /// Register this device for ride notifications.
  ///
  /// Deliberately not awaited by anything the UI depends on: a push problem
  /// must not delay or block the first screen. The registrar reports its own
  /// status and never throws.
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
    setState(() {
      _signedIn = token != null;
      // A returning user never passes through onSignedIn, so without this
      // their device would only ever be registered on first install.
      if (token != null) _startPush();
      _checking = false;
    });
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

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      onGenerateTitle: (context) => AppStrings.of(context).appNameDriver,
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
      home: Builder(
        builder: (context) {
          if (_checking) {
            return const Scaffold(
              body: Center(child: CircularProgressIndicator()),
            );
          }

          if (!_signedIn) {
            return SignInScreen(
              api: widget.api,
              onSignedIn: () {
                setState(() => _signedIn = true);
                _startPush();
              },
            );
          }

          // CLAUDE.md §5.3 - the permission and Doze-exemption flow runs at
          // onboarding, BEFORE the driver can go online. A driver who reaches
          // the online switch without it will silently stop reporting minutes
          // after their screen goes off.
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
                onSignedOut: () {
                  unawaited(_stopPush());
                  setState(() => _signedIn = false);
                },
              );
            },
          );
        },
      ),
    );
  }
}
