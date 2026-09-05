import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_aly/screens/request_ride_screen.dart';

/// The idempotency rule on the rider's home screen.
///
/// CLAUDE.md §5.2 exists because Baghdad mobile networks drop requests
/// mid-flight: "Without this, a rider who loses signal creates 3 rides and 3
/// drivers get dispatched." Every assertion below is one way that sentence
/// comes true if the rule is implemented carelessly.
///
/// Written against [RideIntent] rather than the widget because the rule is
/// arithmetic on one nullable field, and a widget test would have to stand up
/// a map SDK and a GPS fix to reach it.
void main() {
  group('RideIntent', () {
    /// A counter rather than a UUID, so a repeated key is visible as equality
    /// and a fresh one is visible as a different number.
    late int minted;
    late RideIntent intent;

    setUp(() {
      minted = 0;
      intent = RideIntent(mintKey: () => 'key-${++minted}');
    });

    test('mints one key on the first attempt', () {
      expect(intent.beginAttempt(), 'key-1');
      expect(minted, 1);
    });

    test('a retry carries the SAME key, which is the whole point', () {
      final first = intent.beginAttempt();
      intent.onFailure(retryable: true);
      final second = intent.beginAttempt();

      expect(second, first);
      expect(minted, 1, reason: 'a second key would create a second ride');
    });

    test('three attempts through bad coverage are still one intent', () {
      final keys = <String>[];
      for (var attempt = 0; attempt < 3; attempt++) {
        keys.add(intent.beginAttempt());
        intent.onFailure(retryable: true);
      }

      expect(keys.toSet(), hasLength(1));
    });

    test('success clears it, so the next ride is a new request', () {
      final first = intent.beginAttempt();
      intent.onSuccess();

      expect(intent.isLive, isFalse);
      expect(intent.beginAttempt(), isNot(first));
    });

    test('a NON-retryable failure clears it too', () {
      final first = intent.beginAttempt();
      // A rejected request is dead. Reusing its key would ask the server to
      // return the failure again instead of trying afresh.
      intent.onFailure(retryable: false);

      expect(intent.isLive, isFalse);
      expect(intent.beginAttempt(), isNot(first));
    });

    test('changing the destination abandons the intent', () {
      final first = intent.beginAttempt();
      intent.abandon();

      expect(intent.isLive, isFalse);
      expect(
        intent.beginAttempt(),
        isNot(first),
        reason: 'a different trip must never reuse the previous key, or the '
            'server returns the first ride for the second request',
      );
    });

    test('is not live before the first attempt', () {
      expect(intent.isLive, isFalse);
      expect(minted, 0);
    });
  });
}
