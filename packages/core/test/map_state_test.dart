import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The map state machine.
///
/// These are pure-logic tests and need no device, no API key and no network —
/// which is the point of separating the state from the widget. The rendering
/// needs a key; deciding *what to tell the user* does not, and that is the
/// part that is easy to get wrong.
void main() {
  group('recovery action', () {
    test('a missing API key offers NOTHING to retry', () {
      // The single most important row. A build-time configuration problem
      // cannot be fixed by the person holding the phone, and a retry button
      // that can never succeed is worse than no button.
      expect(
        recoveryFor(const MapState.unavailable('no key')),
        MapRecovery.none,
      );
    });

    test('a denied permission offers to ask again', () {
      expect(
        recoveryFor(const MapState.permissionDenied()),
        MapRecovery.requestPermission,
      );
    });

    test('a PERMANENTLY denied permission sends the user to settings', () {
      // Android stops showing the dialog after two refusals. Asking again is
      // a no-op, so the only way forward is app settings.
      expect(
        recoveryFor(const MapState.permissionPermanentlyDenied()),
        MapRecovery.openAppSettings,
      );
    });

    test('disabled location services go to OS settings, not a permission prompt', () {
      // The permission is not what is missing. Prompting for it does nothing.
      expect(
        recoveryFor(const MapState.locationDisabled()),
        MapRecovery.openLocationSettings,
      );
    });

    test('offline and transient failures offer retry', () {
      expect(recoveryFor(const MapState.offline()), MapRecovery.retry);
      expect(recoveryFor(const MapState.failed('tiles timed out')), MapRecovery.retry);
    });

    test('loading and ready offer nothing', () {
      expect(recoveryFor(const MapState.loading()), MapRecovery.none);
      expect(
        recoveryFor(const MapState.ready(LatLng(lat: 33.3, lng: 44.4))),
        MapRecovery.none,
      );
    });

    test('every state has a recovery action', () {
      // Exhaustiveness: a new state added without a recovery decision must
      // fail to compile, not silently fall through to `none`.
      const states = <MapState>[
        MapState.loading(),
        MapState.ready(LatLng(lat: 0, lng: 0)),
        MapState.unavailable('x'),
        MapState.offline(),
        MapState.locationDisabled(),
        MapState.permissionDenied(),
        MapState.permissionPermanentlyDenied(),
        MapState.failed('x'),
      ];

      for (final state in states) {
        expect(recoveryFor(state), isA<MapRecovery>());
      }
      expect(states.length, 8);
    });
  });

  group('can the map still be drawn', () {
    test('yes when permission is refused — panning by hand still works', () {
      // Hiding the map because the blue dot is unavailable removes the one
      // thing that still functions: choosing a pickup point manually.
      expect(canRenderMap(const MapState.permissionDenied()), isTrue);
      expect(canRenderMap(const MapState.permissionPermanentlyDenied()), isTrue);
      expect(canRenderMap(const MapState.locationDisabled()), isTrue);
    });

    test('no when there is nothing to draw', () {
      expect(canRenderMap(const MapState.loading()), isFalse);
      expect(canRenderMap(const MapState.unavailable('no key')), isFalse);
      expect(canRenderMap(const MapState.offline()), isFalse);
      expect(canRenderMap(const MapState.failed('boom')), isFalse);
    });

    test('yes when ready', () {
      expect(canRenderMap(const MapState.ready(LatLng(lat: 33.3, lng: 44.4))), isTrue);
    });
  });

  group('MapReady carries its centre', () {
    test('the centre survives the state', () {
      const state = MapState.ready(LatLng(lat: 33.3152, lng: 44.3661));
      expect((state as MapReady).centre.lat, closeTo(33.3152, 0.0001));
      expect(state.centre.lng, closeTo(44.3661, 0.0001));
    });
  });
}
