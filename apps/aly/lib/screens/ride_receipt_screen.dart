import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The receipt for a finished ride.
///
/// Renders the ride that was passed in rather than refetching it. A completed
/// ride is immutable — the fare is settled and the ledger is append-only
/// (CLAUDE.md §6.3) — so a network round trip here would add a loading state
/// and a failure mode to a screen that has nothing new to learn.
class RideReceiptScreen extends StatelessWidget {
  const RideReceiptScreen({required this.ride, required this.api, super.key});

  final Ride ride;

  /// Needed only to file a dispute. The receipt itself never re-fetches.
  final ApiClient api;

  /// A rider can report the fare, a driver who never arrived, or unsafe
  /// behaviour. `riderNoShow` is deliberately absent — it is the driver's
  /// complaint, and offering it here invites a report about oneself.
  static const _riderReasons = [
    DisputeReason.fareWrong,
    DisputeReason.driverNoShow,
    DisputeReason.unsafe,
    DisputeReason.other,
  ];

  Future<void> _report(BuildContext context) async {
    final strings = AppStrings.of(context);
    final dispute = await showReportProblemSheet(
      context: context,
      api: api,
      rideId: ride.id,
      reasons: _riderReasons,
    );
    if (dispute == null || !context.mounted) return;

    // The reference is the point: a complaint with no receipt is one the rider
    // has no reason to believe was filed.
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
    final settled = ride.finalFareIqd;

    return Scaffold(
      appBar: AppBar(title: Text(strings.receipt)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          _Section(
            title: strings.statusLabel(ride.status),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Row(
                  label: strings.rideNumber,
                  // Short form: the full UUID is unreadable and a rider only
                  // ever needs enough to quote to support.
                  value: ride.id.split('-').first.toUpperCase(),
                  monospace: true,
                ),
                _Row(
                  label: strings.requestedAt,
                  value: formatDateTimeAr(ride.requestedAt),
                ),
                if (ride.completedAt != null)
                  _Row(
                    label: strings.completedAt,
                    value: formatDateTimeAr(ride.completedAt!),
                  ),
              ],
            ),
          ),

          _Section(
            title: strings.route,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Point(
                  icon: Icons.trip_origin,
                  color: AppColors.primary,
                  label: strings.pickup,
                  address: ride.pickupAddress,
                  point: ride.pickup,
                ),
                const SizedBox(height: AppSpacing.sm),
                _Point(
                  icon: Icons.place,
                  color: AppColors.danger,
                  label: strings.destination,
                  address: ride.dropoffAddress,
                  point: ride.dropoff,
                ),
              ],
            ),
          ),

          if (ride.driver != null)
            _Section(
              title: strings.driver,
              child: CounterpartyCard(user: ride.driver!),
            ),

          _Section(
            title: strings.fare,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (settled == null) ...[
                  // Never present an estimate as if it were charged.
                  _Row(label: strings.estimated, value: null, amount: ride.estimatedFareIqd),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    strings.fareNotSettledYet,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ] else ...[
                  _Row(label: strings.total, value: null, amount: settled, emphasis: true),
                  if (ride.actualDistanceM != null)
                    _Row(
                      label: strings.distance,
                      value: strings.distanceKm(ride.actualDistanceM! / 1000),
                    ),
                ],
                const SizedBox(height: AppSpacing.xs),
                _Row(label: strings.paymentMethod, value: strings.cash),
              ],
            ),
          ),

          if (ride.cancellationReason != null)
            _Section(
              title: strings.cancellationReason,
              child: Text(ride.cancellationReason!),
            ),

          const SizedBox(height: AppSpacing.sm),
          OutlinedButton.icon(
            onPressed: () => _report(context),
            icon: const Icon(Icons.flag_outlined),
            label: Text(strings.reportProblem),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(48),
            ),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Card(
        margin: const EdgeInsets.only(bottom: AppSpacing.md),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: AppSpacing.sm),
              child,
            ],
          ),
        ),
      );
}

class _Row extends StatelessWidget {
  const _Row({
    required this.label,
    required this.value,
    this.amount,
    this.monospace = false,
    this.emphasis = false,
  });

  final String label;
  final String? value;
  final IqdAmount? amount;
  final bool monospace;
  final bool emphasis;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: theme.textTheme.bodyMedium?.copyWith(
            color: AppColors.textSecondary,
          ),),
          if (amount != null)
            FareText(amount!, large: emphasis)
          else
            Text(
              value ?? '—',
              // An id or a number reads left-to-right even in an RTL page.
              textDirection: monospace ? TextDirection.ltr : null,
              style: monospace
                  ? theme.textTheme.bodyMedium?.copyWith(fontFamily: 'monospace')
                  : theme.textTheme.bodyMedium,
            ),
        ],
      ),
    );
  }
}

class _Point extends StatelessWidget {
  const _Point({
    required this.icon,
    required this.color,
    required this.label,
    required this.address,
    required this.point,
  });

  final IconData icon;
  final Color color;
  final String label;
  final String? address;
  final LatLng point;

  @override
  Widget build(BuildContext context) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: Theme.of(context).textTheme.bodySmall),
                Text(
                  // Coordinates are the fallback, not the goal — reverse
                  // geocoding fills the address when it is available.
                  address ??
                      '${point.lat.toStringAsFixed(4)}, ${point.lng.toStringAsFixed(4)}',
                  textDirection: address == null ? TextDirection.ltr : null,
                ),
              ],
            ),
          ),
        ],
      );
}
