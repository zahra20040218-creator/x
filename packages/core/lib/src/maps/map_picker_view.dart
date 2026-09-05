import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' as gmap;
import 'package:rideapp_core/src/design/theme.dart';
import 'package:rideapp_core/src/design/widgets.dart';
import 'package:rideapp_core/src/l10n/strings.dart';
import 'package:rideapp_core/src/maps/location_gate.dart';
import 'package:rideapp_core/src/maps/map_state.dart';
import 'package:rideapp_core/src/models/models.dart';

/// Pick a point on a map.
///
/// Shared between rider and driver because CLAUDE.md §1 treats duplicated
/// widget code between the two apps as a defect.
///
/// ## The pin does not move; the map does
///
/// A draggable marker requires the user to hit a small target with a thumb,
/// and on a moving bus that is genuinely hard. A fixed centre pin over a
/// pannable map means the whole screen is the target. It is also what every
/// ride-hailing app does, so it needs no explaining.
///
/// ## It never crashes without an API key
///
/// `hasApiKey` is passed in rather than probed, because the key lives in the
/// Android manifest and Dart cannot read it. When it is false the map is not
/// instantiated at all — the Maps SDK renders a blank grey tile in that case,
/// which a user cannot tell apart from a network failure.
class MapPickerView extends StatefulWidget {
  const MapPickerView({
    required this.initialCentre,
    required this.onConfirm,
    required this.hasApiKey,
    this.title,
    this.gate = const GeolocatorLocationGate(),
    super.key,
  });

  final LatLng initialCentre;
  final ValueChanged<LatLng> onConfirm;

  /// Whether the build injected a Maps key. See the class comment.
  final bool hasApiKey;

  final String? title;
  final LocationGate gate;

  @override
  State<MapPickerView> createState() => _MapPickerViewState();
}

class _MapPickerViewState extends State<MapPickerView> {
  MapState _state = const MapState.loading();
  late LatLng _centre = widget.initialCentre;
  gmap.GoogleMapController? _controller;

  @override
  void initState() {
    super.initState();
    unawaitedResolve();
  }

  @override
  void dispose() {
    // Without this the platform view leaks for the lifetime of the process,
    // and a user who opens the picker repeatedly accumulates map instances.
    _controller?.dispose();
    super.dispose();
  }

  void unawaitedResolve() {
    // ignore: discarded_futures -- fire and forget by design; _resolve owns
    // its own error handling and writes the outcome to state.
    _resolve();
  }

  Future<void> _resolve() async {
    setState(() => _state = const MapState.loading());

    try {
      final serviceEnabled = await widget.gate.isLocationServiceEnabled();
      final permission = await widget.gate.checkPermission();

      if (!mounted) return;
      setState(() {
        _state = stateForPermission(
          serviceEnabled: serviceEnabled,
          permission: permission,
          hasApiKey: widget.hasApiKey,
        );
      });
    } catch (error) {
      if (!mounted) return;
      // Never rethrow into the widget tree: a failed permission probe must
      // degrade to a retryable message, not a red screen.
      setState(() => _state = MapState.failed(error.toString()));
    }
  }

  Future<void> _act(MapRecovery recovery) async {
    switch (recovery) {
      case MapRecovery.none:
        return;
      case MapRecovery.retry:
        await _resolve();
      case MapRecovery.requestPermission:
        await widget.gate.requestPermission();
        await _resolve();
      case MapRecovery.openAppSettings:
        await widget.gate.openAppSettings();
        // Deliberately re-resolved on return: the user may have granted it.
        await _resolve();
      case MapRecovery.openLocationSettings:
        await widget.gate.openLocationSettings();
        await _resolve();
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(widget.title ?? strings.pickOnMap)),
      body: Stack(
        alignment: Alignment.center,
        children: [
          if (canRenderMap(_state))
            gmap.GoogleMap(
              initialCameraPosition: gmap.CameraPosition(
                target: gmap.LatLng(_centre.lat, _centre.lng),
                zoom: 15,
              ),
              onMapCreated: (controller) => _controller = controller,
              // The blue dot only when we are actually allowed to show it.
              myLocationEnabled: _state is MapReady,
              myLocationButtonEnabled: _state is MapReady,
              zoomControlsEnabled: false,
              onCameraMove: (position) => _centre =
                  LatLng(lat: position.target.latitude, lng: position.target.longitude),
            )
          else
            const ColoredBox(color: AppColors.surfaceVariant, child: SizedBox.expand()),

          if (canRenderMap(_state))
            // Sits above the map centre. Offset upward by half its own height
            // so the pin's POINT marks the centre, not the icon's middle.
            const Padding(
              padding: EdgeInsets.only(bottom: 48),
              child: Icon(Icons.place, size: 48, color: AppColors.danger),
            ),

          if (_state is MapLoading)
            const Center(child: CircularProgressIndicator()),

          _MapMessage(state: _state, onAct: _act),

          if (canRenderMap(_state))
            PositionedDirectional(
              start: AppSpacing.md,
              end: AppSpacing.md,
              bottom: AppSpacing.lg,
              child: PrimaryButton(
                label: strings.confirm,
                onPressed: () => widget.onConfirm(_centre),
              ),
            ),
        ],
      ),
    );
  }
}

/// The banner explaining a non-ready state, with the one action that helps.
class _MapMessage extends StatelessWidget {
  const _MapMessage({required this.state, required this.onAct});

  final MapState state;
  final Future<void> Function(MapRecovery) onAct;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final recovery = recoveryFor(state);

    final message = switch (state) {
      MapLoading() || MapReady() => null,
      MapUnavailable() => strings.mapUnavailable,
      MapOffline() => strings.offline,
      MapLocationDisabled() => strings.locationServicesOff,
      MapPermissionDenied() => strings.locationPermissionNeeded,
      MapPermissionPermanentlyDenied() => strings.locationPermissionBlocked,
      MapFailed(:final message) => message,
    };

    if (message == null) return const SizedBox.shrink();

    final actionLabel = switch (recovery) {
      MapRecovery.none => null,
      MapRecovery.retry => strings.retry,
      MapRecovery.requestPermission => strings.grantPermission,
      MapRecovery.openAppSettings => strings.openSettings,
      MapRecovery.openLocationSettings => strings.openSettings,
    };

    return PositionedDirectional(
      top: AppSpacing.md,
      start: AppSpacing.md,
      end: AppSpacing.md,
      child: Material(
        elevation: 2,
        borderRadius: BorderRadius.circular(AppRadius.md),
        color: AppColors.surface,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(message, textAlign: TextAlign.center),
              if (actionLabel != null) ...[
                const SizedBox(height: AppSpacing.sm),
                PrimaryButton(
                  label: actionLabel,
                  onPressed: () => onAct(recovery),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
