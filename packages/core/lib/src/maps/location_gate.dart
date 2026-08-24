import 'package:geolocator/geolocator.dart';

import '../models/models.dart';
import 'map_state.dart';

/// Turns the platform's location situation into a [MapState].
///
/// A thin seam on purpose: `geolocator` talks to the OS and cannot run in a
/// unit test, but the *decision* — which of the eight states applies, and
/// therefore what the user is told — is ordinary logic and must be testable.
/// That decision lives in [stateForPermission], which takes plain values.
abstract interface class LocationGate {
  /// Are location services switched on at the OS level?
  Future<bool> isLocationServiceEnabled();

  Future<LocationPermission> checkPermission();

  Future<LocationPermission> requestPermission();

  Future<bool> openAppSettings();

  Future<bool> openLocationSettings();
}

class GeolocatorLocationGate implements LocationGate {
  const GeolocatorLocationGate();

  @override
  Future<bool> isLocationServiceEnabled() => Geolocator.isLocationServiceEnabled();

  @override
  Future<LocationPermission> checkPermission() => Geolocator.checkPermission();

  @override
  Future<LocationPermission> requestPermission() => Geolocator.requestPermission();

  @override
  Future<bool> openAppSettings() => Geolocator.openAppSettings();

  @override
  Future<bool> openLocationSettings() => Geolocator.openLocationSettings();
}

/// The whole decision, as a pure function.
///
/// `serviceEnabled` is checked BEFORE permission, and that order is
/// deliberate: with location services switched off, the permission answer is
/// meaningless, and prompting for a permission the user may already have
/// granted teaches them the app is broken.
MapState stateForPermission({
  required bool serviceEnabled,
  required LocationPermission permission,
  required bool hasApiKey,
}) {
  // Checked first of all. Without a key nothing renders regardless of
  // permissions, and telling someone to grant location access when the real
  // problem is a missing build key wastes their time on a fix that cannot work.
  if (!hasApiKey) {
    return const MapState.unavailable('MAPS_API_KEY is not configured');
  }

  if (!serviceEnabled) return const MapState.locationDisabled();

  return switch (permission) {
    LocationPermission.denied => const MapState.permissionDenied(),
    LocationPermission.deniedForever => const MapState.permissionPermanentlyDenied(),
    LocationPermission.whileInUse ||
    LocationPermission.always ||
    // `unableToDetermine` is treated as usable: the map still draws and the
    // user can still pan to a pickup point by hand. Blocking on it would
    // remove the only thing that still works.
    LocationPermission.unableToDetermine =>
      const MapState.ready(LatLng(lat: 33.3152, lng: 44.3661)),
  };
}
