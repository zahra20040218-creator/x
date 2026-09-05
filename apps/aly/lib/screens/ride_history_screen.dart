import 'package:flutter/material.dart';
import 'package:rideapp_aly/screens/ride_receipt_screen.dart';
import 'package:rideapp_core/rideapp_core.dart';

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
          ),);
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
          // AlyRideCard, not a hand-rolled tile: it is the component that
          // knows the three fare cases — settled, estimated, and none — and
          // never renders a ride with no fare as "0 د.ع", which reads as a
          // fact rather than as an absence.
          success: (context, rides) => ListView.separated(
            // Always scrollable so pull-to-refresh works even on a short list.
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
            itemCount: rides.length,
            separatorBuilder: (_, __) => const SizedBox(height: AlySpacing.md),
            itemBuilder: (context, index) => AlyRideCard(
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
