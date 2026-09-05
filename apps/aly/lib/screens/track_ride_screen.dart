import 'dart:async';

import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Live ride tracking, from "finding a driver" to the rating prompt.
///
/// Updates arrive over the WebSocket. There is also a polling fallback on a
/// timer, for the same reason the driver app polls for offers: a rider staring
/// at "searching for a driver" while the socket is quietly dead is the worst
/// possible failure, because it looks like the platform has no drivers.
class TrackRideScreen extends StatefulWidget {
  const TrackRideScreen({required this.api, required this.ride, super.key});

  final ApiClient api;
  final Ride ride;

  @override
  State<TrackRideScreen> createState() => _TrackRideScreenState();
}

class _TrackRideScreenState extends State<TrackRideScreen> {
  late Ride _ride = widget.ride;
  LatLng? _driverPosition;
  RealtimeClient? _realtime;
  StreamSubscription<RealtimeEvent>? _events;
  Timer? _poll;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _connect();
    // The socket is primary; this is the fallback for the case it is not
    // connected. Longer than it was, because a poll that duplicates a working
    // socket is load for nothing.
    _poll = Timer.periodic(const Duration(seconds: 20), (_) => unawaited(_refresh()));
  }

  @override
  void dispose() {
    _poll?.cancel();
    unawaited(_events?.cancel());
    unawaited(_realtime?.dispose());
    super.dispose();
  }

  /// Open the realtime channel.
  ///
  /// The client sends only its token. It does NOT name a channel - the server
  /// derives that from the token's subject, so there is no frame this app could
  /// send that would subscribe it to another rider's stream.
  ///
  /// `RealtimeClient` is shared with the driver app: the reconnect, backoff and
  /// resync logic this screen used to carry inline is the same logic the driver
  /// needs, and CLAUDE.md 1 makes the second copy a defect.
  void _connect() {
    final client = RealtimeClient(
      url: kRealtimeUrlFromEnv,
      tokenProvider: widget.api.currentAccessToken,
      // The socket cannot replay what was missed while it was down, so the
      // screen refetches. Without this a rider who lost signal for a minute
      // reconnects and keeps showing the ride as it was before the gap.
      onReconnect: () => unawaited(_refresh()),
    );
    _realtime = client;
    _events = client.events.listen(_onEvent);
    unawaited(client.connect());
  }

  void _onEvent(RealtimeEvent event) {
    final payload = event.payload;

    switch (event.type) {
      case 'ride.status_changed':
        unawaited(_refresh());
      case 'driver.location':
        if (payload['lat'] != null && payload['lng'] != null && mounted) {
          setState(() {
            _driverPosition = LatLng(
              lat: (payload['lat'] as num).toDouble(),
              lng: (payload['lng'] as num).toDouble(),
            );
          });
        }
    }
  }

  Future<void> _refresh() async {
    try {
      final ride = await widget.api.getRide(_ride.id);
      if (mounted) setState(() => _ride = ride);
    } on ApiException {
      // Transient; the next tick tries again.
    }
  }

  Future<void> _cancel() async {
    final strings = AppStrings.of(context);

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(strings.cancelRideConfirm),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(strings.back),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(strings.confirm),
          ),
        ],
      ),
    );

    if (!(confirmed ?? false)) return;

    setState(() => _busy = true);
    try {
      final ride = await widget.api.cancelRide(_ride.id);
      if (mounted) setState(() => _ride = ride);
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = error.problem == ApiProblem.network
            ? strings.noInternet
            : strings.somethingWentWrong,);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final driver = _ride.driver;

    final statusLabel = switch (_ride.status) {
      RideStatus.requested || RideStatus.offered => strings.searchingForDriver,
      RideStatus.accepted => strings.driverOnTheWay,
      RideStatus.driverArrived => strings.driverHasArrived,
      RideStatus.inProgress => strings.onTrip,
      RideStatus.completed => strings.rideCompleted,
      RideStatus.noDriversFound => strings.noDriversFound,
      _ => strings.rideCompleted,
    };

    return Scaffold(
      appBar: AppBar(title: Text(statusLabel)),
      body: ListView(
        padding: const EdgeInsetsDirectional.all(AppSpacing.md),
        children: [
          if (_error != null)
            StatusBanner(message: _error!, tone: BannerTone.danger),

          if (_ride.status == RideStatus.requested ||
              _ride.status == RideStatus.offered)
            const Padding(
              padding: EdgeInsetsDirectional.symmetric(vertical: AppSpacing.xl),
              child: Center(child: CircularProgressIndicator()),
            ),

          if (_ride.status == RideStatus.noDriversFound)
            StatusBanner(message: strings.noDriversFound, tone: BannerTone.warning),

          if (driver != null) ...[
            CounterpartyCard(user: driver),
            if (_driverPosition != null)
              Padding(
                padding: const EdgeInsetsDirectional.only(top: AppSpacing.sm),
                child: Text(
                  '${_driverPosition!.lat.toStringAsFixed(4)}, ${_driverPosition!.lng.toStringAsFixed(4)}',
                  textDirection: TextDirection.ltr,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
          ],

          const SizedBox(height: AppSpacing.md),
          Card(
            child: Padding(
              padding: const EdgeInsetsDirectional.all(AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _ride.finalFareIqd != null
                        ? strings.total
                        : strings.estimatedFare,
                    style: Theme.of(context)
                        .textTheme
                        .bodyMedium
                        ?.copyWith(color: AppColors.textSecondary),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  FareText(_ride.displayFareIqd, large: true),
                ],
              ),
            ),
          ),

          if (_ride.status.isActive && _ride.status != RideStatus.inProgress) ...[
            const SizedBox(height: AppSpacing.lg),
            OutlinedButton(
              onPressed: _busy ? null : _cancel,
              child: Text(
                strings.cancelRide,
                style: const TextStyle(color: AppColors.danger),
              ),
            ),
          ],

          if (_ride.status == RideStatus.completed) ...[
            const SizedBox(height: AppSpacing.lg),
            _RatingCard(api: widget.api, rideId: _ride.id),
          ],
        ],
      ),
    );
  }
}

class _RatingCard extends StatefulWidget {
  const _RatingCard({required this.api, required this.rideId});

  final ApiClient api;
  final String rideId;

  @override
  State<_RatingCard> createState() => _RatingCardState();
}

class _RatingCardState extends State<_RatingCard> {
  int _score = 5;
  bool _submitted = false;
  bool _busy = false;

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      await widget.api.rateRide(widget.rideId, score: _score);
      if (mounted) setState(() => _submitted = true);
    } on ApiException catch (error) {
      // A duplicate rating is a 409. The rating already exists, so from the
      // rider's point of view it succeeded.
      if (mounted && error.problem == ApiProblem.conflict) {
        setState(() => _submitted = true);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    if (_submitted) {
      return StatusBanner(message: strings.rideCompleted);
    }

    return Card(
      child: Padding(
        padding: const EdgeInsetsDirectional.all(AppSpacing.md),
        child: Column(
          children: [
            Text(strings.rateYourDriver,
                style: Theme.of(context).textTheme.titleLarge,),
            const SizedBox(height: AppSpacing.md),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(5, (index) {
                final value = index + 1;
                return IconButton(
                  iconSize: 36,
                  onPressed: () => setState(() => _score = value),
                  icon: Icon(
                    value <= _score ? Icons.star : Icons.star_border,
                    color: AppColors.accent,
                  ),
                );
              }),
            ),
            const SizedBox(height: AppSpacing.md),
            PrimaryButton(
              label: strings.submitRating,
              onPressed: _submit,
              busy: _busy,
            ),
          ],
        ),
      ),
    );
  }
}
