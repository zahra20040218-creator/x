import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// CLAUDE.md §6.1 and §8, on the client side.
///
/// The server enforces whole-dinar money at its boundary; these tests are the
/// app holding the same line, because a `double` reaching the screen is what a
/// user actually sees and complains about.
void main() {
  group('IqdAmount.fromJson', () {
    test('accepts an integer', () {
      expect(IqdAmount.fromJson(12500), 12500);
      expect(IqdAmount.fromJson(0), 0);
    });

    test('accepts a whole double, which JSON may deliver', () {
      expect(IqdAmount.fromJson(12500.0), 12500);
    });

    // Rounding here would HIDE a server defect until the numbers stopped
    // adding up months later.
    test('throws on a fractional value rather than truncating it', () {
      expect(() => IqdAmount.fromJson(12500.5), throwsFormatException);
      expect(() => IqdAmount.fromJson(0.1), throwsFormatException);
    });

    test('parses an integer string', () {
      expect(IqdAmount.fromJson('12500'), 12500);
    });

    test('throws on a decimal string', () {
      expect(() => IqdAmount.fromJson('12500.5'), throwsFormatException);
    });

    test('throws on nonsense', () {
      expect(() => IqdAmount.fromJson('abc'), throwsFormatException);
      expect(() => IqdAmount.fromJson(null), throwsFormatException);
      expect(() => IqdAmount.fromJson(<String, dynamic>{}), throwsFormatException);
    });

    test('handles a negative balance, which a wallet may legitimately have', () {
      expect(IqdAmount.fromJson(-3000), -3000);
    });
  });

  group('IqdFormatter', () {
    // CLAUDE.md §8: `12,500 د.ع` - thousands separator, no decimals.
    test('formats with a thousands separator and the dinar mark', () {
      expect(IqdFormatter.format(12500), '12,500 د.ع');
      expect(IqdFormatter.format(500), '500 د.ع');
      expect(IqdFormatter.format(1000000), '1,000,000 د.ع');
      expect(IqdFormatter.format(0), '0 د.ع');
    });

    test('formats a negative balance', () {
      expect(IqdFormatter.format(-12500), '-12,500 د.ع');
    });

    test('never emits a decimal separator in the numeric part', () {
      for (final value in [1, 12, 123, 1234, 12345, 123456, 1234567]) {
        final numericPart = IqdFormatter.format(value).replaceAll(' د.ع', '');
        expect(numericPart.contains('.'), isFalse);
        expect(numericPart.contains('٫'), isFalse);
      }
    });

    test('bare form omits the currency mark', () {
      expect(IqdFormatter.formatBare(12500), '12,500');
    });
  });

  group('RideStatus', () {
    test('round-trips every wire value', () {
      for (final status in RideStatus.values) {
        expect(RideStatus.fromWire(status.wire), status);
      }
    });

    // A silent default would render a live ride as a finished one.
    test('throws on an unknown status rather than defaulting', () {
      expect(() => RideStatus.fromWire('TELEPORTED'), throwsFormatException);
    });

    test('classifies terminal states', () {
      expect(RideStatus.completed.isTerminal, isTrue);
      expect(RideStatus.cancelledByRider.isTerminal, isTrue);
      expect(RideStatus.noDriversFound.isTerminal, isTrue);
      expect(RideStatus.inProgress.isTerminal, isFalse);
      expect(RideStatus.requested.isTerminal, isFalse);
    });

    test('classifies active states', () {
      expect(RideStatus.requested.isActive, isTrue);
      expect(RideStatus.inProgress.isActive, isTrue);
      expect(RideStatus.completed.isActive, isFalse);
    });

    test('knows when a driver is assigned and the map should track', () {
      expect(RideStatus.accepted.hasAssignedDriver, isTrue);
      expect(RideStatus.inProgress.hasAssignedDriver, isTrue);
      expect(RideStatus.requested.hasAssignedDriver, isFalse);
      expect(RideStatus.offered.hasAssignedDriver, isFalse);
    });

    test('no state is both terminal and active', () {
      for (final status in RideStatus.values) {
        expect(status.isTerminal && status.isActive, isFalse,
            reason: '${status.wire} cannot be both');
      }
    });
  });

  group('PublicUser', () {
    // ACCEPTANCE_CHECKLIST.md check 5. The guarantee is structural: there is no
    // phone field to populate, so no server response can put one on screen.
    test('has no phone field, even when the server sends one', () {
      final user = PublicUser.fromJson({
        'id': 'u1',
        'displayName': 'أحمد',
        'rating': 4.8,
        'phone': '+9647700000001',
      });

      expect(user.displayName, 'أحمد');
      expect(user.toString().contains('964'), isFalse);
    });
  });

  group('RideOffer', () {
    test('counts down against the server deadline', () {
      final now = DateTime.utc(2026, 1, 1, 12);
      final offer = RideOffer.fromJson({
        'offerId': 'o1',
        'rideId': 'r1',
        'pickup': {'lat': 33.3, 'lng': 44.4},
        'dropoff': {'lat': 33.2, 'lng': 44.5},
        'estimatedFareIqd': 5000,
        'distanceM': 1200,
        'expiresAt': now.add(const Duration(seconds: 15)).toIso8601String(),
      });

      expect(offer.remaining(now).inSeconds, 15);
      expect(offer.remaining(now.add(const Duration(seconds: 10))).inSeconds, 5);
    });

    // A negative countdown would render as a negative number on the sheet.
    test('never reports negative time once the deadline has passed', () {
      final now = DateTime.utc(2026, 1, 1, 12);
      final offer = RideOffer.fromJson({
        'offerId': 'o1',
        'rideId': 'r1',
        'pickup': {'lat': 33.3, 'lng': 44.4},
        'dropoff': {'lat': 33.2, 'lng': 44.5},
        'estimatedFareIqd': 5000,
        'distanceM': 1200,
        'expiresAt': now.subtract(const Duration(seconds: 5)).toIso8601String(),
      });

      expect(offer.remaining(now), Duration.zero);
    });
  });

  group('FareBreakdown', () {
    // If the parts do not sum to the total, the driver is shown arithmetic
    // that does not add up.
    test('parts sum to the total', () {
      final breakdown = FareBreakdown.fromJson({
        'baseIqd': 2000,
        'distanceIqd': 1100,
        'timeIqd': 400,
        'minimumAppliedIqd': 0,
        'roundingIqd': 250,
      });

      expect(breakdown.total, 3750);
    });
  });
}
