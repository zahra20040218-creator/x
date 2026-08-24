import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The permission decision, tested without a device.
///
/// `geolocator` needs an OS. Deciding what to tell the user does not, and it
/// is the half that is easy to get wrong — so it is a pure function and this
/// file covers every branch.
void main() {
  group('a missing API key wins over everything', () {
    test('even with perfect permissions', () {
      // Telling someone to grant location access when the real problem is a
      // build-time key sends them to fix something that will not help.
      expect(
        stateForPermission(
          serviceEnabled: true,
          permission: LocationPermission.always,
          hasApiKey: false,
        ),
        isA<MapUnavailable>(),
      );
    });

    test('and with no permissions at all', () {
      expect(
        stateForPermission(
          serviceEnabled: false,
          permission: LocationPermission.deniedForever,
          hasApiKey: false,
        ),
        isA<MapUnavailable>(),
      );
    });
  });

  group('service state is checked before permission', () {
    test('disabled services report locationDisabled even when permission is granted', () {
      // With services off the permission answer is meaningless. Prompting for
      // a permission the user already granted teaches them the app is broken.
      expect(
        stateForPermission(
          serviceEnabled: false,
          permission: LocationPermission.always,
          hasApiKey: true,
        ),
        isA<MapLocationDisabled>(),
      );
    });
  });

  group('permission mapping', () {
    test('denied can be asked again', () {
      expect(
        stateForPermission(
          serviceEnabled: true,
          permission: LocationPermission.denied,
          hasApiKey: true,
        ),
        isA<MapPermissionDenied>(),
      );
    });

    test('deniedForever is a distinct state, not just another denial', () {
      final state = stateForPermission(
        serviceEnabled: true,
        permission: LocationPermission.deniedForever,
        hasApiKey: true,
      );
      expect(state, isA<MapPermissionPermanentlyDenied>());
      // And it must route to settings, not to another prompt.
      expect(recoveryFor(state), MapRecovery.openAppSettings);
    });

    test('whileInUse and always are both ready', () {
      for (final p in [LocationPermission.whileInUse, LocationPermission.always]) {
        expect(
          stateForPermission(serviceEnabled: true, permission: p, hasApiKey: true),
          isA<MapReady>(),
          reason: '$p should render a usable map',
        );
      }
    });

    test('unableToDetermine still renders a map', () {
      // The blue dot is unavailable; panning to a pickup point by hand is not.
      expect(
        stateForPermission(
          serviceEnabled: true,
          permission: LocationPermission.unableToDetermine,
          hasApiKey: true,
        ),
        isA<MapReady>(),
      );
    });

    test('every LocationPermission value is handled', () {
      for (final p in LocationPermission.values) {
        expect(
          stateForPermission(serviceEnabled: true, permission: p, hasApiKey: true),
          isA<MapState>(),
          reason: '$p produced no state',
        );
      }
    });
  });
}
