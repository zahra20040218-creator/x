import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The wire contract for fare negotiation, from the Dart side.
///
/// These endpoints and this table have existed on the server since migration
/// 0012; nothing in `packages/core` knew about them, so the feature was
/// unreachable from the app. The tests below pin the shapes to
/// `docs/api-contract.yaml` — a field renamed on the server must fail here
/// rather than silently decode to null in a rider's fare.
void main() {
  group('RideBidStatus', () {
    test('carries every state the contract defines', () {
      // The contract's enum, verbatim. SUPERSEDED matters most: a re-bid
      // writes a new row and marks the old one superseded, because the bid
      // history is what a fare dispute is argued from.
      const fromContract = {
        'ACTIVE',
        'SUPERSEDED',
        'WITHDRAWN',
        'ACCEPTED',
        'REJECTED',
        'EXPIRED',
      };

      expect(
        RideBidStatus.values.map((s) => s.wire).toSet(),
        containsAll(fromContract),
      );
    });

    test('adds exactly one value the contract does not have: the sentinel', () {
      // UNKNOWN is local, and it must stay the ONLY local addition. A second
      // one would mean someone invented a status the server never sends.
      final extra = RideBidStatus.values
          .map((s) => s.wire)
          .where(
            (wire) => !{
              'ACTIVE',
              'SUPERSEDED',
              'WITHDRAWN',
              'ACCEPTED',
              'REJECTED',
              'EXPIRED',
            }.contains(wire),
          )
          .toList();

      expect(extra, ['UNKNOWN']);
    });

    test('round-trips every value through the wire name', () {
      for (final status in RideBidStatus.values) {
        expect(RideBidStatus.fromWire(status.wire), status);
      }
    });

    test('an unknown status does not crash a running app', () {
      // The server may ship a state this build has never seen. Throwing here
      // would take down a rider's offer list over a string.
      expect(RideBidStatus.fromWire('SOMETHING_NEW'), RideBidStatus.unknown);
    });
  });

  group('RideBid.fromJson', () {
    Map<String, dynamic> bid({Map<String, dynamic>? overrides}) => {
          'id': '11111111-1111-1111-1111-111111111111',
          'rideId': '22222222-2222-2222-2222-222222222222',
          'driverId': '33333333-3333-3333-3333-333333333333',
          'amountIqd': 7500,
          'deltaIqd': -500,
          'status': 'ACTIVE',
          'etaSeconds': 240,
          'distanceM': 1200,
          'createdAt': '2026-09-07T10:00:00Z',
          'expiresAt': '2026-09-07T10:02:00Z',
          ...?overrides,
        };

    test('reads the full bid a rider sees', () {
      final parsed = RideBid.fromJson(bid());

      expect(parsed.amountIqd, 7500);
      expect(parsed.deltaIqd, -500);
      expect(parsed.status, RideBidStatus.active);
      expect(parsed.etaToPickup, const Duration(seconds: 240));
    });

    test("the delta is the SERVER's number, never recomputed here", () {
      // The contract is explicit that deltaIqd is computed server-side because
      // two clients computing it separately is two chances to get the sign
      // wrong. A bid dearer than the proposal must stay positive.
      final parsed = RideBid.fromJson(bid(overrides: {'deltaIqd': 1500}));
      expect(parsed.deltaIqd, 1500);
    });

    test('a driver reading back their own bid gets no rider profile', () {
      // `driver` is absent in that direction by design — a driver has no
      // business receiving another user's profile.
      final parsed = RideBid.fromJson(bid());
      expect(parsed.driver, isNull);
    });

    test('carries the driver when a rider reads the list', () {
      final parsed = RideBid.fromJson(
        bid(overrides: {
          'driver': {
            'id': '33333333-3333-3333-3333-333333333333',
            'displayName': 'علي م.',
            'rating': 4.9,
          },
        },),
      );

      expect(parsed.driver?.displayName, 'علي م.');
    });

    test('tolerates a missing ETA, which is optional in the contract', () {
      final parsed = RideBid.fromJson(bid(overrides: {'etaSeconds': null}));
      expect(parsed.etaToPickup, isNull);
    });

    test('money stays an integer — never a double', () {
      final parsed = RideBid.fromJson(bid());
      // CLAUDE.md §6.1. A double reaching a fare is the money bug the whole
      // system is built to prevent.
      expect(parsed.amountIqd, isA<int>());
    });
  });

  group('OpenRideRequest.fromJson', () {
    test('reads what a driver needs to decide, and no rider identity', () {
      final parsed = OpenRideRequest.fromJson(const {
        'rideId': '44444444-4444-4444-4444-444444444444',
        'pickup': {'lat': 33.3152, 'lng': 44.3661},
        'pickupAddress': 'ساحة التحرير',
        'dropoff': {'lat': 33.3406, 'lng': 44.4009},
        'dropoffAddress': 'الكرادة داخل',
        'proposedFareIqd': 10000,
        'suggestedFareIqd': 12500,
        'distanceToPickupM': 1800,
        'estimatedDistanceM': 6400,
        'expiresAt': '2026-09-07T10:05:00Z',
      });

      expect(parsed.proposedFareIqd, 10000);
      expect(parsed.suggestedFareIqd, 12500);
      expect(parsed.distanceToPickupM, 1800);
      expect(parsed.pickupAddress, 'ساحة التحرير');
    });

    test('survives a request with no addresses, which is the pin case', () {
      final parsed = OpenRideRequest.fromJson(const {
        'rideId': '44444444-4444-4444-4444-444444444444',
        'pickup': {'lat': 33.3152, 'lng': 44.3661},
        'dropoff': {'lat': 33.3406, 'lng': 44.4009},
        'proposedFareIqd': 10000,
        'distanceToPickupM': 1800,
        'estimatedDistanceM': 6400,
        'expiresAt': '2026-09-07T10:05:00Z',
      });

      expect(parsed.pickupAddress, isNull);
      expect(parsed.suggestedFareIqd, isNull);
    });
  });
}
