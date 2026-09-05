import 'package:flutter/foundation.dart';

import 'package:rideapp_core/src/models/models.dart';

/// Every state a map screen can be in.
///
/// The list is longer than the four states everything else in this app uses,
/// and each entry earns its place by needing a *different action* from the
/// user. Collapsing any two of them produces a screen that tells someone to do
/// something that cannot work.
///
/// Inherited from the earlier Kotlin/Compose project, which shipped these
/// screens once already — see `docs/PRIOR_PROJECTS.md`.
@immutable
sealed class MapState {
  const MapState();

  /// Tiles requested, nothing drawn yet.
  const factory MapState.loading() = MapLoading;

  /// Drawn and interactive.
  const factory MapState.ready(LatLng centre) = MapReady;

  /// The API key is missing or rejected.
  ///
  /// Separate from every other failure because no amount of retrying,
  /// reconnecting or re-permissioning fixes it — it is a build configuration
  /// problem, and the only honest thing to tell the user is that the map is
  /// unavailable rather than to offer a retry button that cannot succeed.
  const factory MapState.unavailable(String reason) = MapUnavailable;

  /// The device has no network.
  const factory MapState.offline() = MapOffline;

  /// Location services are switched off at the OS level.
  ///
  /// The fix is a settings intent, NOT a permission prompt. Showing a
  /// permission dialog here does nothing, because the permission is not what
  /// is missing.
  const factory MapState.locationDisabled() = MapLocationDisabled;

  /// Refused, but can be asked again.
  const factory MapState.permissionDenied() = MapPermissionDenied;

  /// Refused permanently — Android stops showing the dialog after two
  /// refusals.
  ///
  /// This is the distinction that matters most. An app that treats it as an
  /// ordinary denial leaves the user tapping a button that can never do
  /// anything, and the only way forward is a link into system settings.
  const factory MapState.permissionPermanentlyDenied() =
      MapPermissionPermanentlyDenied;

  /// Something transient failed and retrying is worth offering.
  const factory MapState.failed(String message) = MapFailed;
}

final class MapLoading extends MapState {
  const MapLoading();
}

final class MapReady extends MapState {
  const MapReady(this.centre);
  final LatLng centre;
}

final class MapUnavailable extends MapState {
  const MapUnavailable(this.reason);
  final String reason;
}

final class MapOffline extends MapState {
  const MapOffline();
}

final class MapLocationDisabled extends MapState {
  const MapLocationDisabled();
}

final class MapPermissionDenied extends MapState {
  const MapPermissionDenied();
}

final class MapPermissionPermanentlyDenied extends MapState {
  const MapPermissionPermanentlyDenied();
}

final class MapFailed extends MapState {
  const MapFailed(this.message);
  final String message;
}

/// What the user can actually do about a given state.
///
/// Derived from the state rather than decided at each call site, so a screen
/// cannot accidentally offer "retry" for a missing API key or a permission
/// prompt for disabled location services.
enum MapRecovery {
  /// Nothing to offer — it is working, or it is loading.
  none,

  /// Retrying may succeed.
  retry,

  /// Ask for the permission again.
  requestPermission,

  /// Send the user to app settings; the in-app prompt is exhausted.
  openAppSettings,

  /// Send the user to the OS location settings.
  openLocationSettings,
}

MapRecovery recoveryFor(MapState state) => switch (state) {
      MapLoading() || MapReady() => MapRecovery.none,
      // Deliberately none: a build-time key cannot be fixed by the user.
      MapUnavailable() => MapRecovery.none,
      MapOffline() || MapFailed() => MapRecovery.retry,
      MapPermissionDenied() => MapRecovery.requestPermission,
      MapPermissionPermanentlyDenied() => MapRecovery.openAppSettings,
      MapLocationDisabled() => MapRecovery.openLocationSettings,
    };

/// True when the map itself can be drawn underneath whatever message is shown.
///
/// A denied permission still leaves a usable map — the user simply cannot see
/// their own position, and can still pan to a pickup point by hand. Hiding the
/// map for a permission problem would remove the one thing that still works.
bool canRenderMap(MapState state) => switch (state) {
      MapReady() ||
      MapPermissionDenied() ||
      MapPermissionPermanentlyDenied() ||
      MapLocationDisabled() =>
        true,
      MapLoading() || MapUnavailable() || MapOffline() || MapFailed() => false,
    };
