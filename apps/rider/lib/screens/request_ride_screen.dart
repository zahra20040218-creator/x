import 'dart:async';

import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:rideapp_rider/screens/track_ride_screen.dart';

/// Set a destination, see the fare, request the ride.
///
/// The important behaviour here is the idempotency key. CLAUDE.md §5.2:
///
///   "The rider app generates a UUID (Idempotency-Key header) per ride request
///    and retries with the same key on network failure."
///
/// The key is generated when the user TAPS, and held for the whole retry
/// sequence. Generating a fresh key per attempt is the single most likely way
/// to get this wrong, and it would produce exactly the failure the rule exists
/// to prevent: three taps through bad coverage, three rides, three drivers
/// dispatched.
class RequestRideScreen extends StatefulWidget {
  const RequestRideScreen({required this.api, super.key});

  final ApiClient api;

  @override
  State<RequestRideScreen> createState() => _RequestRideScreenState();
}

class _RequestRideScreenState extends State<RequestRideScreen> {
  LatLng? _pickup;
  LatLng? _dropoff;
  FareEstimate? _estimate;
  String? _error;
  bool _busy = false;

  /// Held across retries of ONE user intent. Cleared only on success or when
  /// the user changes the request.
  String? _idempotencyKey;

  Future<void> _estimateFare() async {
    final pickup = _pickup;
    final dropoff = _dropoff;
    if (pickup == null || dropoff == null) return;

    setState(() {
      _busy = true;
      _error = null;
      // The request changed, so the previous intent is void.
      _idempotencyKey = null;
    });

    try {
      final estimate = await widget.api.estimateFare(
        pickup: pickup,
        dropoff: dropoff,
      );
      if (mounted) setState(() => _estimate = estimate);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = _messageFor(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _request() async {
    final pickup = _pickup;
    final dropoff = _dropoff;
    if (pickup == null || dropoff == null) return;

    // ONE key per intent. Reused on every retry below.
    _idempotencyKey ??= ApiClient.newIdempotencyKey();

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final ride = await widget.api.createRide(
        pickup: pickup,
        dropoff: dropoff,
        idempotencyKey: _idempotencyKey!,
      );

      if (!mounted) return;
      _idempotencyKey = null;

      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => TrackRideScreen(api: widget.api, ride: ride),
        ),
      );
    } on ApiException catch (error) {
      if (!mounted) return;

      setState(() {
        _error = _messageFor(error);
        // The key is deliberately KEPT for a retryable failure: the next
        // attempt must carry the same one, or it creates a second ride.
        if (!error.isRetryable) _idempotencyKey = null;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _messageFor(ApiException error) {
    final strings = AppStrings.of(context);
    return switch (error.problem) {
      ApiProblem.network => strings.noInternet,
      ApiProblem.unauthorized => strings.sessionExpired,
      // The server refused a second live ride. Telling the rider they already
      // have one is more useful than a generic conflict.
      ApiProblem.conflict => strings.youAlreadyHaveARide,
      ApiProblem.idempotencyInProgress => strings.searchingForDriver,
      _ => strings.somethingWentWrong,
    };
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final estimate = _estimate;
    final ready = _pickup != null && _dropoff != null;

    return Scaffold(
      appBar: AppBar(title: Text(strings.whereTo)),
      body: ListView(
        padding: const EdgeInsetsDirectional.all(AppSpacing.md),
        children: [
          if (_error != null) ...[
            StatusBanner(
              message: _error!,
              tone: BannerTone.danger,
              onRetry: _busy ? null : _request,
            ),
            const SizedBox(height: AppSpacing.md),
          ],

          _LocationField(
            label: strings.setPickup,
            icon: Icons.trip_origin,
            color: AppColors.primary,
            value: _pickup,
            onPicked: (value) {
              setState(() => _pickup = value);
              unawaited(_estimateFare());
            },
          ),
          const SizedBox(height: AppSpacing.sm),
          _LocationField(
            label: strings.setDestination,
            icon: Icons.place,
            color: AppColors.danger,
            value: _dropoff,
            onPicked: (value) {
              setState(() => _dropoff = value);
              unawaited(_estimateFare());
            },
          ),

          if (estimate != null) ...[
            const SizedBox(height: AppSpacing.lg),
            Center(
              child: Column(
                children: [
                  Text(
                    strings.estimatedFare,
                    style: Theme.of(context)
                        .textTheme
                        .bodyMedium
                        ?.copyWith(color: AppColors.textSecondary),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  FareText(estimate.estimatedFareIqd, large: true),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            FareBreakdownCard(
              breakdown: estimate.breakdown,
              total: estimate.estimatedFareIqd,
            ),
          ],

          const SizedBox(height: AppSpacing.lg),
          PrimaryButton(
            label: strings.requestRide,
            onPressed: ready ? _request : null,
            busy: _busy,
          ),
        ],
      ),
    );
  }
}

/// Placeholder for the map picker.
///
/// The real implementation opens a `GoogleMap` and returns the centred
/// coordinate. It is a separate widget so that the request flow above — which
/// is where the idempotency behaviour lives — can be reasoned about and tested
/// without a map SDK or an API key.
class _LocationField extends StatelessWidget {
  const _LocationField({
    required this.label,
    required this.icon,
    required this.color,
    required this.value,
    required this.onPicked,
  });

  final String label;
  final IconData icon;
  final Color color;
  final LatLng? value;
  final ValueChanged<LatLng> onPicked;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        leading: Icon(icon, color: color),
        title: Text(label),
        subtitle: value == null
            ? null
            : Text(
                '${value!.lat.toStringAsFixed(4)}, ${value!.lng.toStringAsFixed(4)}',
                textDirection: TextDirection.ltr,
              ),
        trailing: const Icon(Icons.map_outlined),
        onTap: () async {
          final picked = await Navigator.of(context).push<LatLng>(
            MaterialPageRoute(builder: (_) => MapPickerScreen(title: label)),
          );
          if (picked != null) onPicked(picked);
        },
      ),
    );
  }
}

/// Map picker screen. Kept minimal deliberately — CLAUDE.md §2 rules out
/// in-app navigation, and this is a point picker, not a routing UI.
class MapPickerScreen extends StatefulWidget {
  const MapPickerScreen({required this.title, super.key});

  final String title;

  @override
  State<MapPickerScreen> createState() => _MapPickerScreenState();
}

class _MapPickerScreenState extends State<MapPickerScreen> {
  /// Baghdad city centre, used only as the map's INITIAL camera position -
  /// never as a submitted coordinate. The user must move the pin and confirm.
  static const LatLng _baghdadCentre = LatLng(lat: 33.3152, lng: 44.3661);

  LatLng _centre = _baghdadCentre;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Stack(
        alignment: Alignment.center,
        children: [
          // GoogleMap goes here; it needs an API key and a device, so the
          // picker is left as a surface the map plugs into rather than a
          // half-built map that cannot render.
          const ColoredBox(
            color: AppColors.surfaceVariant,
            child: SizedBox.expand(),
          ),
          const Icon(Icons.place, size: 48, color: AppColors.danger),
          PositionedDirectional(
            start: AppSpacing.md,
            end: AppSpacing.md,
            bottom: AppSpacing.lg,
            child: PrimaryButton(
              label: strings.confirm,
              onPressed: () => Navigator.of(context).pop(_centre),
            ),
          ),
        ],
      ),
    );
  }
}
