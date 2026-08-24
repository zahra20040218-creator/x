import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// What a release build is allowed to point at.
///
/// The failure being guarded is quiet and total: a release bundle built without
/// `--dart-define=API_BASE_URL` fell back to `http://10.0.2.2:3000/v1`, the
/// Android emulator's route to a developer's machine. It installs, it opens,
/// and every request fails with something the user reads as a bad connection.
/// Both release bundles in this repository were built that way before this
/// existed.
///
/// `isRelease` is a parameter rather than `kReleaseMode` precisely so the
/// release rules can be exercised here — a check that can only run in the mode
/// it does not guard is a check nobody has watched work.

void main() {
  EndpointConfig resolve({
    String api = 'https://api.darb.iq/v1',
    String realtime = 'wss://api.darb.iq/v1/realtime',
    bool isRelease = true,
  }) =>
      EndpointConfig.resolve(
        apiBaseUrl: api,
        realtimeUrl: realtime,
        isRelease: isRelease,
      );

  group('a debug build', () {
    test('accepts a developer pointing at their own machine', () {
      // The entire point of the emulator alias. Blocking it here would make
      // the app undevelopable.
      final config = resolve(
        api: 'http://10.0.2.2:3000/v1',
        realtime: 'ws://10.0.2.2:3000/v1/realtime',
        isRelease: false,
      );

      expect(config.apiBaseUrl, 'http://10.0.2.2:3000/v1');
    });

    test('accepts an empty value rather than blocking startup', () {
      expect(() => resolve(api: '', realtime: '', isRelease: false), returnsNormally);
    });
  });

  group('a release build', () {
    test('accepts a real https endpoint', () {
      final config = resolve();
      expect(config.apiBaseUrl, 'https://api.darb.iq/v1');
      expect(config.realtimeUrl, 'wss://api.darb.iq/v1/realtime');
    });

    test('refuses the emulator loopback', () {
      // This is the exact value both release bundles shipped with.
      expect(
        () => resolve(api: 'http://10.0.2.2:3000/v1'),
        throwsA(isA<EndpointConfigError>()),
      );
    });

    for (final host in ['localhost', '127.0.0.1', '10.0.3.2']) {
      test('refuses $host', () {
        expect(
          () => resolve(api: 'https://$host/v1'),
          throwsA(isA<EndpointConfigError>()),
        );
      });
    }

    test('refuses plaintext http even to a real host', () {
      // The bearer token would cross an Iraqi mobile network in the clear.
      expect(
        () => resolve(api: 'http://api.darb.iq/v1'),
        throwsA(isA<EndpointConfigError>()),
      );
    });

    test('refuses ws:// for the socket', () {
      expect(
        () => resolve(realtime: 'ws://api.darb.iq/v1/realtime'),
        throwsA(isA<EndpointConfigError>()),
      );
    });

    test('refuses an empty API_BASE_URL, naming the flag to pass', () {
      // The message has to say what to do; "invalid configuration" sends
      // someone reading source at the worst possible moment.
      expect(
        () => resolve(api: ''),
        throwsA(
          isA<EndpointConfigError>().having(
            (e) => e.message,
            'message',
            allOf(contains('API_BASE_URL'), contains('--dart-define')),
          ),
        ),
      );
    });

    test('refuses a string that is not a URL at all', () {
      expect(
        () => resolve(api: 'api.darb.iq'),
        throwsA(isA<EndpointConfigError>()),
      );
    });

    test('checks the socket too, not only the API', () {
      // Both carry the session token; checking one is checking neither.
      expect(
        () => resolve(realtime: ''),
        throwsA(
          isA<EndpointConfigError>()
              .having((e) => e.message, 'message', contains('REALTIME_URL')),
        ),
      );
    });
  });

  group('the constants this binary was built with', () {
    test('are the defaults, because these tests pass no dart-define', () {
      // Guards against the two declarations drifting apart: main and the
      // track screen read the same const, and this is what it is.
      expect(kApiBaseUrlFromEnv, 'http://10.0.2.2:3000/v1');
      expect(kRealtimeUrlFromEnv, 'ws://10.0.2.2:3000/v1/realtime');
    });

    test('would not survive a release build unchanged', () {
      // The defaults are development values. If this ever stops throwing,
      // someone has made a development default acceptable in production.
      expect(
        () => EndpointConfig.resolve(
          apiBaseUrl: kApiBaseUrlFromEnv,
          realtimeUrl: kRealtimeUrlFromEnv,
          isRelease: true,
        ),
        throwsA(isA<EndpointConfigError>()),
      );
    });
  });
}
