import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';

import 'ride_receipt_screen.dart';

/// Past rides.
///
/// Built on `AsyncView` rather than hand-rolled state flags, which is what
/// forces all four states to exist: `empty` and `onRetry` are required
/// parameters, so a rider with no history sees an explanation instead of a
/// blank list.
class RideHistoryScreen extends StatefulWidget {
  const RideHistoryScreen({required this.api, super.key});

  final ApiClient api;

  @override
  State<RideHistoryScreen> createState() => _RideHistoryScreenState();
}

class _RideHistoryScreenState extends State<RideHistoryScreen> {
  ViewState<List<Ride>> _state = const ViewState<List<Ride>>.loading();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _state = const ViewState<List<Ride>>.loading());
    try {
      final rides = await widget.api.myRides(limit: 50);
      if (!mounted) return;
      // `fromList` collapses "loaded but nothing there" into Empty rather than
      // a Success carrying an empty list, which is how a blank screen with no
      // explanation gets shipped.
      setState(() => _state = ViewState.fromList(rides));
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _state = ViewState<List<Ride>>.error(
            error.detail ?? error.problem.slug,
            // A 401 is not worth a retry button; the session is gone and the
            // app will route to sign-in.
            canRetry: !error.requiresReauthentication,
          ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(strings.rideHistory)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: AsyncView<List<Ride>>(
          state: _state,
          onRetry: _load,
          empty: (context) => EmptyView(message: strings.noRidesYet),
          success: (context, rides) => ListView.separated(
            // Always scrollable so pull-to-refresh works even on a short list.
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: rides.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, index) => _RideTile(
              ride: rides[index],
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => RideReceiptScreen(
                    ride: rides[index],
                    api: widget.api,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RideTile extends StatelessWidget {
  const _RideTile({required this.ride, required this.onTap});

  final Ride ride;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final settled = ride.displayFareIqd;

    return ListTile(
      onTap: onTap,
      leading: _StatusDot(status: ride.status),
      title: Text(
        ride.dropoffAddress ?? strings.statusLabel(ride.status),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        formatDateTimeAr(ride.completedAt ?? ride.requestedAt),
        style: Theme.of(context).textTheme.bodySmall,
      ),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          FareText(settled),
          // An estimate and a settled fare must not look identical — a rider
          // comparing the two should be able to tell which they were charged.
          if (ride.finalFareIqd == null)
            Text(
              strings.estimated,
              style: Theme.of(context).textTheme.bodySmall,
            ),
        ],
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});

  final RideStatus status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      RideStatus.completed => AppColors.success,
      RideStatus.cancelledByRider ||
      RideStatus.cancelledByDriver ||
      RideStatus.cancelledInTrip ||
      RideStatus.noDriversFound ||
      RideStatus.expired =>
        AppColors.danger,
      _ => AppColors.accent,
    };

    return CircleAvatar(
      radius: 6,
      backgroundColor: color,
      // A colour alone is not a label. Screen readers and colour-blind users
      // both need the status in words.
      child: Semantics(label: AppStrings.of(context).statusLabel(status), child: const SizedBox()),
    );
  }
}
