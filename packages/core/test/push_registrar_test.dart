import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Push registration.
///
/// The failure this guards against is silent: a token that goes stale and is
/// never re-registered means the driver's phone simply stops ringing, with
/// nothing in any log to say so. Every branch below corresponds to a way that
/// can happen.

class _FakeSource implements PushTokenSource {
  // Mutable fields rather than constructor parameters: each test changes the
  // one condition it is about, which reads better than a constructor call
  // whose other two arguments are noise.
  @override
  bool isConfigured = true;
  bool permission = true;
  String? token = 'token-1';

  int permissionCalls = 0;
  int tokenCalls = 0;
  final _refresh = StreamController<String>.broadcast();

  @override
  Future<bool> requestPermission() async {
    permissionCalls++;
    return permission;
  }

  @override
  Future<String?> getToken() async {
    tokenCalls++;
    return token;
  }

  @override
  Stream<String> get onTokenRefresh => _refresh.stream;

  void rotate(String next) => _refresh.add(next);
  Future<void> close() => _refresh.close();
}

/// Records what the server was asked to do.
class _RecordingApi implements ApiClient {
  final List<String> registered = [];
  final List<String> unregistered = [];
  bool failRegister = false;
  bool failUnregister = false;

  @override
  Future<void> registerDevice({required String token, String platform = 'ANDROID'}) async {
    if (failRegister) {
      throw ApiException(
        problem: ApiProblem.network,
        status: 0,
        detail: 'offline',
        errors: [],
      );
    }
    registered.add(token);
  }

  @override
  Future<void> unregisterDevice(String token) async {
    if (failUnregister) {
      throw ApiException(
        problem: ApiProblem.network,
        status: 0,
        detail: 'offline',
        errors: [],
      );
    }
    unregistered.add(token);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError('${invocation.memberName} is not used by these tests');
}

void main() {
  late _FakeSource source;
  late _RecordingApi api;
  late PushRegistrar registrar;

  setUp(() {
    source = _FakeSource();
    api = _RecordingApi();
    registrar = PushRegistrar(api: api, source: source);
  });

  tearDown(() async {
    await registrar.dispose();
    await source.close();
  });

  group('the happy path', () {
    test('registers the token and reports it', () async {
      expect(await registrar.start(), PushStatus.registered);
      expect(api.registered, ['token-1']);
      expect(registrar.registeredToken, 'token-1');
    });
  });

  group('why a device might not be reachable', () {
    test('no Firebase configuration is its own status, not a failure', () async {
      // A build with no google-services.json can never produce a token. Saying
      // "registration failed" would send someone to check the network.
      source.isConfigured = false;

      expect(await registrar.start(), PushStatus.notConfigured);
      expect(api.registered, isEmpty);
      // And it must not even ask for the permission, which would prompt the
      // user for something that cannot work.
      expect(source.permissionCalls, 0);
    });

    test('a refused permission is distinct from a failed registration', () async {
      source.permission = false;

      expect(await registrar.start(), PushStatus.permissionDenied);
      expect(api.registered, isEmpty);
      expect(source.tokenCalls, 0);
    });

    test('a null token reports failure rather than registering empty', () async {
      source.token = null;
      expect(await registrar.start(), PushStatus.registrationFailed);
      expect(api.registered, isEmpty);
    });

    test('an empty token is treated as no token', () async {
      source.token = '';
      expect(await registrar.start(), PushStatus.registrationFailed);
      expect(api.registered, isEmpty);
    });

    test('a server failure never throws out of start()', () async {
      api.failRegister = true;

      // A notification problem must not stop someone using the app.
      expect(await registrar.start(), PushStatus.registrationFailed);
      expect(registrar.registeredToken, isNull);
    });
  });

  group('token rotation — the silent failure', () {
    test('re-registers when FCM issues a new token', () async {
      await registrar.start();
      source.rotate('token-2');
      await Future<void>.delayed(Duration.zero);

      // Without this the server keeps an address that no longer exists and
      // the phone stops ringing, with nothing to indicate why.
      expect(api.registered, ['token-1', 'token-2']);
      expect(registrar.registeredToken, 'token-2');
    });

    test('does not re-register the same token', () async {
      await registrar.start();
      source.rotate('token-1');
      await Future<void>.delayed(Duration.zero);

      // FCM re-emits the current token on some platforms. Registering it again
      // burns a CRITICAL-tier rate-limit slot for nothing.
      expect(api.registered, ['token-1']);
    });

    test('subscribes once even if start is called repeatedly', () async {
      await registrar.start();
      await registrar.start();
      await registrar.start();

      source.rotate('token-2');
      await Future<void>.delayed(Duration.zero);

      // A second subscription would register every rotation twice.
      expect(api.registered, ['token-1', 'token-2']);
    });
  });

  group('sign-out', () {
    test('unregisters the device', () async {
      await registrar.start();
      await registrar.stop();

      expect(api.unregistered, ['token-1']);
      expect(registrar.registeredToken, isNull);
      expect(registrar.status, PushStatus.unknown);
    });

    test('stops listening, so a later rotation does not re-register', () async {
      await registrar.start();
      await registrar.stop();

      source.rotate('token-2');
      await Future<void>.delayed(Duration.zero);

      // Otherwise a signed-out handset would silently re-register itself and
      // receive the next driver's offers.
      expect(api.registered, ['token-1']);
    });

    test('a network failure does not block sign-out', () async {
      await registrar.start();
      api.failUnregister = true;

      // Must not throw: stranding someone in a session they asked to end is
      // worse than a stale device row.
      await expectLater(registrar.stop(), completes);
      expect(registrar.registeredToken, isNull);
    });

    test('stopping without ever starting is harmless', () async {
      await expectLater(registrar.stop(), completes);
      expect(api.unregistered, isEmpty);
    });
  });
}
