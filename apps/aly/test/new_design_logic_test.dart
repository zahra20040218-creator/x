import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_aly/screens/design_logic.dart';

/// The decisions the redesigned screens make, separated from the widgets that
/// draw them.
///
/// Both were about to become an `if` inside a `build` — a greeting computed
/// from `DateTime.now()` and a countdown ticking on a Timer — and neither would
/// have had a test, for the same reason nothing on these screens did: you
/// cannot reach 4am, or the 59th second of a resend window, by tapping.
void main() {
  group('Greeting', () {
    test('morning runs from first light to noon', () {
      expect(Greeting.forHour(5), Greeting.morning);
      expect(Greeting.forHour(8), Greeting.morning);
      expect(Greeting.forHour(11), Greeting.morning);
    });

    test('afternoon and evening are one greeting in Arabic', () {
      // Arabic has no separate "good afternoon" in common use; مساء الخير
      // covers everything after noon, and inventing a third greeting would put
      // a phrase on screen that nobody says.
      expect(Greeting.forHour(12), Greeting.evening);
      expect(Greeting.forHour(17), Greeting.evening);
      expect(Greeting.forHour(21), Greeting.evening);
    });

    test('the small hours greet a driver working nights, not nobody', () {
      // A driver signing on at 3am is the reason this is tested. Falling
      // through to an empty string, or to "صباح الخير" at 2am, both read as a
      // bug to the person most likely to see it.
      expect(Greeting.forHour(0), Greeting.evening);
      expect(Greeting.forHour(3), Greeting.evening);
      expect(Greeting.forHour(4), Greeting.evening);
    });

    test('every hour of the day produces a greeting', () {
      for (var hour = 0; hour < 24; hour++) {
        expect(() => Greeting.forHour(hour), returnsNormally);
      }
    });
  });

  group('ResendCountdown', () {
    test('starts closed, for the full window', () {
      final countdown = ResendCountdown(window: const Duration(minutes: 2))
        ..sentAt = DateTime(2026, 9, 6, 10);

      expect(countdown.canResendAt(DateTime(2026, 9, 6, 10)), isFalse);
      expect(
        countdown.remainingAt(DateTime(2026, 9, 6, 10)),
        const Duration(minutes: 2),
      );
    });

    test('counts down', () {
      final countdown = ResendCountdown(window: const Duration(minutes: 2))
        ..sentAt = DateTime(2026, 9, 6, 10);

      expect(
        countdown.remainingAt(DateTime(2026, 9, 6, 10, 0, 2)),
        const Duration(seconds: 118),
        reason: '01:58 is the first thing the rider reads',
      );
    });

    test('opens exactly when the window elapses', () {
      final countdown = ResendCountdown(window: const Duration(minutes: 2))
        ..sentAt = DateTime(2026, 9, 6, 10);

      expect(countdown.canResendAt(DateTime(2026, 9, 6, 10, 1, 59)), isFalse);
      expect(countdown.canResendAt(DateTime(2026, 9, 6, 10, 2)), isTrue);
    });

    test('never reports a negative remainder', () {
      final countdown = ResendCountdown(window: const Duration(minutes: 2))
        ..sentAt = DateTime(2026, 9, 6, 10);

      // A screen left open for an hour must not render "-58:00".
      expect(
        countdown.remainingAt(DateTime(2026, 9, 6, 11)),
        Duration.zero,
      );
    });

    test('is open before a code has ever been sent', () {
      // Nothing to wait for yet. A rider who has not requested a code must not
      // be told to wait two minutes for one.
      final countdown = ResendCountdown(window: const Duration(minutes: 2));

      expect(countdown.canResendAt(DateTime(2026, 9, 6, 10)), isTrue);
      expect(countdown.remainingAt(DateTime(2026, 9, 6, 10)), Duration.zero);
    });

    test('restarts on every send, so a second code closes it again', () {
      final countdown = ResendCountdown(window: const Duration(minutes: 2))
        ..sentAt = DateTime(2026, 9, 6, 10)
        ..sentAt = DateTime(2026, 9, 6, 10, 5);

      expect(countdown.canResendAt(DateTime(2026, 9, 6, 10, 6)), isFalse);
      expect(
        countdown.remainingAt(DateTime(2026, 9, 6, 10, 6)),
        const Duration(minutes: 1),
      );
    });

    test('formats as mm:ss, zero padded', () {
      expect(ResendCountdown.format(const Duration(seconds: 118)), '01:58');
      expect(ResendCountdown.format(const Duration(seconds: 5)), '00:05');
      expect(ResendCountdown.format(Duration.zero), '00:00');
      expect(ResendCountdown.format(const Duration(seconds: 600)), '10:00');
    });
  });
}
