import 'package:flutter/material.dart';

/// What to show when the app cannot start.
///
/// `EndpointConfig` and `Firebase.initializeApp` both fail before there is a
/// localisation delegate, a theme, or an API client — so this deliberately
/// depends on none of them. It is English, because the audience is whoever
/// built the bundle, not the person holding the phone: a user should never
/// reach this screen, and if they do the only useful thing on it is the text
/// someone can send to the developer.
///
/// The alternative is an uncaught exception, which on Android is a launch
/// crash: no message, no way to tell a bad build from a broken handset, and
/// the same blank failure for every user at once.
class MisconfiguredApp extends StatelessWidget {
  const MisconfiguredApp({required this.detail, super.key});

  final String detail;

  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          backgroundColor: const Color(0xFF1C1B1F),
          body: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.build_circle_outlined,
                      color: Color(0xFFFFB4AB), size: 48,),
                  const SizedBox(height: 16),
                  const Text(
                    'This build is misconfigured',
                    textDirection: TextDirection.ltr,
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 12),
                  SelectableText(
                    detail,
                    textDirection: TextDirection.ltr,
                    style: const TextStyle(
                      color: Color(0xFFE6E1E5),
                      fontSize: 14,
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
}
