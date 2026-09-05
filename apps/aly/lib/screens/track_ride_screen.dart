import 'dart:async';

import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// What the tracking screen offers, for one ride status.
///
/// These were `if` conditions inside a `build` method, and so had no tests:
/// reaching "the driver cancelled while the rider watched" needs a server, a
/// driver and a race. As a value it needs an enum.
///
/// The consequential one is [canCancel]. CLAUDE.md §4 permits
/// `CANCELLED_IN_TRIP` to an **admin only**, so a rider offered a cancel
/// button mid-journey is being offered either a control the state machine will
/// refuse, or — worse, if it ever stopped refusing — a way to strand a driver
/// halfway to the destination.
@immutable
class TrackRideView {
  const TrackRideView._({
    required this.isSearching,
    required this.showsTimeline,
    required this.canCancel,
    required this.canRate,
    required this.noDriversFound,
  });

  /// Derived, never stored. The ride's status is the server's, and a second
  /// copy of "what that means" is a second thing to keep in sync.
  factory TrackRideView.of(RideStatus status) => TrackRideView._(
        // No driver has taken it yet, so there is nothing to draw but a wait.
        isSearching: status == RideStatus.requested ||
            status == RideStatus.offered,

        // Before acceptance there are no timestamps, and an empty timeline
        // reads as a stalled one rather than as an early one.
        showsTimeline: !const {
          RideStatus.requested,
          RideStatus.offered,
          RideStatus.expired,
          RideStatus.noDriversFound,
        }.contains(status),

        // Active, but not once the trip is under way. See the class comment.
        canCancel: status.isActive && status != RideStatus.inProgress,

        // Only a completed ride has a service to rate. Asking after a
        // cancellation reads as the app not knowing what happened.
        canRate: status == RideStatus.completed,

        noDriversFound: status == RideStatus.noDriversFound,
      );

  final bool isSearching;
  final bool showsTimeline;
  final bool canCancel;
  final bool canRate;
  final bool noDriversFound;
}

/// Whether a failed rating should nonetheless be shown to the rider as done.
///
/// A duplicate rating answers 409: the rating already exists, which is exactly
/// what the rider was trying to achieve. Telling them it failed would invite a
/// third attempt that answers 409 again.
///
/// Deliberately narrow. A network failure and an expired session are both
/// genuine failures with a retry that could work, and swallowing either would
/// silently discard the rider's rating.
bool ratingCountsAsSubmitted(ApiException error) =>
    error.problem == ApiProblem.conflict;

/// Live ride tracking, from "finding a driver" to the rating prompt.
///
/// ## Why this screen holds no layout
///
/// Same split as the rider's home (see `request_ride_screen.dart`): the
/// timeline, the driver's card and the route are `AlyTripStatusTimeline`,
/// `AlyDriverCard` and `AlyRouteSummary` in `packages/core`, each already
/// tested in both themes and at large text scales. This class owns the socket,
/// the poll and the two API calls, decides a [TrackRideView], and renders it.
///
/// ## Why the socket and the timer both exist
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
    _poll = Timer.periodic(
      const Duration(seconds: 20),
      (_) => unawaited(_refresh()),
    );
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
  /// needs, and CLAUDE.md §1 makes the second copy a defect.
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

  /// Only the status matters to this screen today.
  ///
  /// `driver.location` still arrives on the socket and is deliberately not
  /// handled here. The screen this replaced printed the raw coordinate as text
  /// — a stand-in for a map, and not a thing a rider can read. Its home is a
  /// marker on the tracking map, which this build has no key for; keeping a
  /// field nobody renders would be dead state (CLAUDE.md §12.7). See
  /// DEFECTS.md D-12.
  void _onEvent(RealtimeEvent event) {
    if (event.type == 'ride.status_changed') unawaited(_refresh());
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
      builder: (dialogContext) => AlyConfirmationDialog(
        title: strings.cancelRide,
        message: strings.cancelRideConfirm,
        confirmLabel: strings.confirm,
        cancelLabel: strings.back,
        isDestructive: true,
      ),
    );

    if (!(confirmed ?? false) || !mounted) return;

    setState(() => _busy = true);
    try {
      final ride = await widget.api.cancelRide(_ride.id);
      if (mounted) setState(() => _ride = ride);
    } on ApiException catch (error) {
      if (mounted) {
        setState(
          () => _error = error.problem == ApiProblem.network
              ? strings.noInternet
              : strings.somethingWentWrong,
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _statusLabel(AppStrings strings) => switch (_ride.status) {
        RideStatus.requested || RideStatus.offered => strings.searchingForDriver,
        RideStatus.accepted => strings.driverOnTheWay,
        RideStatus.driverArrived => strings.driverHasArrived,
        RideStatus.inProgress => strings.onTrip,
        RideStatus.completed => strings.rideCompleted,
        RideStatus.noDriversFound => strings.noDriversFound,
        _ => strings.rideCompleted,
      };

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final view = TrackRideView.of(_ride.status);
    final driver = _ride.driver;

    return Scaffold(
      appBar: AppBar(title: Text(_statusLabel(strings))),
      body: ListView(
        padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
        children: [
          if (_error != null) ...[
            AlyErrorState(
              title: strings.somethingWentWrong,
              message: _error!,
              retryLabel: strings.retry,
              onRetry: () => unawaited(_refresh()),
            ),
            const SizedBox(height: AlySpacing.lg),
          ],

          if (view.isSearching) ...[
            // A skeleton, not a spinner: the driver's card and the timeline are
            // about to occupy this space, and a sheet that resizes when they
            // land reads as a glitch.
            const AlySkeletonRow(),
            const SizedBox(height: AlySpacing.lg),
          ],

          if (view.noDriversFound) ...[
            // Not an error state — nothing failed. The request was answered,
            // and the answer was nobody.
            AlyEmptyState(
              icon: Icons.local_taxi_rounded,
              title: strings.noDriversFound,
              message: strings.noDriversFoundBody,
            ),
            const SizedBox(height: AlySpacing.lg),
          ],

          AlyRouteSummary.forRide(_ride),
          const SizedBox(height: AlySpacing.lg),

          if (driver != null) ...[
            AlyDriverCard(driver: driver),
            const SizedBox(height: AlySpacing.lg),
          ],

          if (view.showsTimeline) ...[
            AlyTripStatusTimeline.forRide(_ride),
            const SizedBox(height: AlySpacing.lg),
          ],

          AlyCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _ride.finalFareIqd != null
                      ? strings.total
                      : strings.estimatedFare,
                  style: AlyTypography.bodySmall.copyWith(
                    color: AlyColors.of(context).textSecondary,
                  ),
                ),
                const SizedBox(height: AlySpacing.xs),
                FareText(_ride.displayFareIqd, large: true),
              ],
            ),
          ),

          if (view.canCancel) ...[
            const SizedBox(height: AlySpacing.xl),
            AlyButton.danger(
              label: strings.cancelRide,
              onPressed: _busy ? null : _cancel,
              isLoading: _busy,
            ),
          ],

          if (view.canRate) ...[
            const SizedBox(height: AlySpacing.xl),
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
      // See [ratingCountsAsSubmitted]: a duplicate is a success the rider
      // already achieved, everything else is a failure they can retry.
      if (mounted && ratingCountsAsSubmitted(error)) {
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
      return AlyEmptyState(
        icon: Icons.check_circle_rounded,
        title: strings.thankYou,
        message: strings.ratingSubmitted,
      );
    }

    return AlyCard(
      child: Column(
        children: [
          Text(
            strings.rateYourDriver,
            style: AlyTypography.h3.copyWith(
              color: AlyColors.of(context).textPrimary,
            ),
          ),
          const SizedBox(height: AlySpacing.lg),
          AlyRatingStars.input(
            value: _score.toDouble(),
            onChanged: (value) => setState(() => _score = value),
          ),
          const SizedBox(height: AlySpacing.lg),
          AlyButton(
            label: strings.submitRating,
            onPressed: _submit,
            isLoading: _busy,
          ),
        ],
      ),
    );
  }
}
