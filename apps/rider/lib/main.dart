import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:rideapp_rider/screens/request_ride_screen.dart';
import 'package:rideapp_rider/screens/sign_in_screen.dart';
import 'package:rideapp_rider/screens/track_ride_screen.dart';

/// Rider app entry point. Android only in v1 (CLAUDE.md §2 — no iOS builds).
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

  final tokens = SecureTokenStore();
  final api = ApiClient(
    baseUrl: const String.fromEnvironment(
      'API_BASE_URL',
      defaultValue: 'http://10.0.2.2:3000/v1',
    ),
    tokens: tokens,
  );

  runApp(RiderApp(api: api, tokens: tokens));
}

class RiderApp extends StatefulWidget {
  const RiderApp({required this.api, required this.tokens, super.key});

  final ApiClient api;
  final TokenStore tokens;

  @override
  State<RiderApp> createState() => _RiderAppState();
}

class _RiderAppState extends State<RiderApp> {
  bool _signedIn = false;
  bool _checking = true;
  Ride? _activeRide;

  @override
  void initState() {
    super.initState();
    unawaited(_restore());
  }

  Future<void> _restore() async {
    final token = await widget.tokens.accessToken();

    if (token != null) {
      try {
        // A rider who force-quit mid-ride must come back INTO that ride, not
        // to a fresh "where to?" screen with a driver already on the way.
        final rides = await widget.api.myRides(limit: 5);
        _activeRide = rides.where((r) => r.status.isActive).firstOrNull;
      } on ApiException {
        // Offline at launch. The request screen still opens; the ride will be
        // picked up on the next successful call.
      }
    }

    if (!mounted) return;
    setState(() {
      _signedIn = token != null;
      _checking = false;
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
              onSignedIn: () => setState(() => _signedIn = true),
            );
          }

          final active = _activeRide;
          if (active != null) {
            return TrackRideScreen(api: widget.api, ride: active);
          }

          return RequestRideScreen(
            api: widget.api,
            onSignedOut: () => setState(() {
              _signedIn = false;
              _activeRide = null;
            }),
          );
        },
      ),
    );
  }
}
