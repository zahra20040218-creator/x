import 'package:firebase_messaging/firebase_messaging.dart';

import 'push_registrar.dart';

/// The real FCM token source.
///
/// Deliberately thin: everything that can be decided without a platform
/// channel lives in [PushRegistrar], so this class has no branching worth
/// testing and the sequence that does is covered by fakes.
class FirebasePushTokenSource implements PushTokenSource {
  const FirebasePushTokenSource({required this.isConfigured});

  /// Whether the build injected Firebase configuration.
  ///
  /// Passed in rather than probed: on Android the values come from
  /// `google-services.json` through the Gradle plugin, and Dart cannot see
  /// whether that file was present at build time. Asking Firebase directly
  /// would mean catching an initialisation error, which is a worse way to
  /// answer a question the build already knows.
  @override
  final bool isConfigured;

  @override
  Future<bool> requestPermission() async {
    final settings = await FirebaseMessaging.instance.requestPermission();
    // `provisional` counts: iOS quiet notifications still deliver, and on
    // Android it does not occur. Treating it as a refusal would silently
    // disable push for users who never actually said no.
    return settings.authorizationStatus == AuthorizationStatus.authorized ||
        settings.authorizationStatus == AuthorizationStatus.provisional;
  }

  @override
  Future<String?> getToken() => FirebaseMessaging.instance.getToken();

  @override
  Stream<String> get onTokenRefresh => FirebaseMessaging.instance.onTokenRefresh;
}
