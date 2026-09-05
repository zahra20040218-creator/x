import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:url_launcher/url_launcher.dart';

/// The live trip: arrive, start, complete.
///
/// Navigation is a DEEP LINK to Google Maps, not an in-app map route.
/// CLAUDE.md §2 puts in-app navigation explicitly out of scope, and building it
/// anyway would be the "scaffold for later" §12.7 forbids.
class TripScreen extends StatefulWidget {
  const TripScreen({
    required this.api,
    required this.ride,
    required this.onFinished,
    super.key,
  });

  final ApiClient api;
  final Ride ride;
  final Future<void> Function() onFinished;

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen> {
  late Ride _ride = widget.ride;
  bool _busy = false;
  String? _error;

  Future<void> _act(Future<Ride> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });

    final strings = AppStrings.of(context);

    try {
      final updated = await action();
      if (!mounted) return;
      setState(() => _ride = updated);

      if (updated.status.isTerminal) {
        await widget.onFinished();
      }
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = switch (error.problem) {
          ApiProblem.network => strings.noInternet,
          ApiProblem.invalidRideTransition =>
            error.detail ?? strings.somethingWentWrong,
          ApiProblem.rideActorNotPermitted => strings.somethingWentWrong,
          _ => strings.somethingWentWrong,
        };
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Hand off to Google Maps. §2: deep-link, do not build navigation.
  Future<void> _navigate() async {
    final target = _ride.status == RideStatus.inProgress
        ? _ride.dropoff
        : _ride.pickup;

    final uri = Uri.parse(
      'google.navigation:q=${target.lat},${target.lng}&mode=d',
    );

    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      // Google Maps may not be installed. The browser fallback still gets the
      // driver there rather than leaving the button dead.
      await launchUrl(
        Uri.parse(
          'https://www.google.com/maps/dir/?api=1&destination=${target.lat},${target.lng}&travelmode=driving',
        ),
        mode: LaunchMode.externalApplication,
      );
    }
  }

  /// A driver's complaints are their own: a rider who never appeared, or
  /// unsafe behaviour. `driverNoShow` is absent because it is a report about
  /// themselves.
  static const _driverReasons = [
    DisputeReason.riderNoShow,
    DisputeReason.unsafe,
    DisputeReason.fareWrong,
    DisputeReason.other,
  ];

  Future<void> _report() async {
    final strings = AppStrings.of(context);
    final dispute = await showReportProblemSheet(
      context: context,
      api: widget.api,
      rideId: _ride.id,
      reasons: _driverReasons,
    );
    if (dispute == null || !mounted) return;

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          '${strings.reportReceived} — ${strings.reportReference} ${dispute.reference}',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final rider = _ride.rider;

    final (actionLabel, action) = switch (_ride.status) {
      RideStatus.accepted => (
          strings.iHaveArrived,
          () => widget.api.markArrived(_ride.id),
        ),
      RideStatus.driverArrived => (
          strings.startTrip,
          () => widget.api.startRide(_ride.id),
        ),
      RideStatus.inProgress => (
          strings.completeTrip,
          () => widget.api.completeRide(_ride.id),
        ),
      _ => (strings.ok, () async => _ride),
    };

    return Scaffold(
      appBar: AppBar(title: Text(strings.onTrip)),
      body: ListView(
        padding: const EdgeInsetsDirectional.all(AppSpacing.md),
        children: [
          if (_error != null)
            StatusBanner(message: _error!, tone: BannerTone.danger),

          if (rider != null) CounterpartyCard(user: rider),

          const SizedBox(height: AppSpacing.md),
          Card(
            child: Padding(
              padding: const EdgeInsetsDirectional.all(AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    strings.estimatedFare,
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

          const SizedBox(height: AppSpacing.md),
          AlyButton.secondary(
              label: strings.navigateToPickup,
              onPressed: _navigate,
              icon: Icons.navigation_rounded,
            ),

          const SizedBox(height: AppSpacing.lg),
          AlyButton(label: actionLabel, onPressed: () => _act(action), isLoading: _busy),

          if (_ride.status == RideStatus.accepted ||
              _ride.status == RideStatus.driverArrived) ...[
            const SizedBox(height: AppSpacing.sm),
            TextButton(
              onPressed: _busy
                  ? null
                  : () => _act(() => widget.api.cancelRide(_ride.id)),
              child: Text(
                strings.cancelRide,
                style: const TextStyle(color: AppColors.danger),
              ),
            ),
          ],

          // Offered from the moment the driver has arrived, because that is
          // when a rider who never appears becomes a real cost to them. Before
          // arrival there is nothing yet to report.
          if (_ride.status == RideStatus.driverArrived ||
              _ride.status == RideStatus.inProgress) ...[
            TextButton.icon(
              onPressed: _busy ? null : _report,
              icon: const Icon(Icons.flag_rounded, size: 18),
              label: Text(strings.reportProblem),
            ),
          ],
        ],
      ),
    );
  }
}
