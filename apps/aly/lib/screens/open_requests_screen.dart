import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Ride requests this driver may bid on.
///
/// The other half of `RideOffersScreen`. The server has served
/// `/driver/ride-requests` and `/rides/{id}/bids` since migration 0012 and no
/// Dart client knew either route; nothing here is new API.
///
/// ## Why a 403 and a 404 mean different things
///
/// 404 is "this platform does not negotiate" — `negotiation_enabled` is off,
/// and the screen simply has nothing to show. 403 is "YOU may not drive right
/// now", which is a capability refusal with reasons attached (CLAUDE.md §1.1),
/// and the driver is owed those reasons rather than an empty list. Collapsing
/// the two would tell a suspended driver the market is quiet.
class OpenRequestsScreen extends StatefulWidget {
  const OpenRequestsScreen({required this.api, super.key});

  final ApiClient api;

  @override
  State<OpenRequestsScreen> createState() => _OpenRequestsScreenState();
}

class _OpenRequestsScreenState extends State<OpenRequestsScreen> {
  List<OpenRideRequest> _requests = const [];
  List<String> _blockers = const [];
  String? _error;
  bool _loading = true;
  bool _negotiationOff = false;
  bool _submitting = false;

  Timer? _poll;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
    _poll = Timer.periodic(
      const Duration(seconds: 10),
      (_) => unawaited(_refresh()),
    );
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final requests = await widget.api.openRideRequests();
      if (!mounted) return;
      setState(() {
        _requests = requests;
        _loading = false;
        _error = null;
        _blockers = const [];
      });
    } on ApiException catch (error) {
      if (!mounted) return;

      if (error.problem == ApiProblem.notFound) {
        _poll?.cancel();
        setState(() {
          _negotiationOff = true;
          _loading = false;
        });
        return;
      }

      if (error.problem == ApiProblem.driverModeUnavailable) {
        // Every reason, in the server's order. A driver blocked for three
        // reasons who fixes one and is still blocked has learned nothing.
        setState(() {
          _blockers = error.driverBlockers;
          _loading = false;
        });
        return;
      }

      setState(() {
        _loading = false;
        _error = error.problem == ApiProblem.network
            ? AppStrings.of(context).noInternet
            : AppStrings.of(context).somethingWentWrong;
      });
    }
  }

  /// Open the bid sheet for one request.
  Future<void> _bid(OpenRideRequest request) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      isDismissible: !_submitting,
      builder: (sheetContext) => AlyCounterOfferSheet(
        riderOfferIqd: request.proposedFareIqd,
        distanceM: request.estimatedDistanceM,
        // The tariff's own duration is not on this payload, and a number
        // invented from the distance would be a guess shown as a fact. The
        // sheet needs a Duration, so it gets the honest zero.
        tripDuration: Duration.zero,
        deadline: request.expiresAt,
        pickupAddress: request.pickupAddress,
        dropoffAddress: request.dropoffAddress,
        isSubmitting: _submitting,
        // Accepting the rider's price IS a bid at exactly that amount. One
        // path to commit means one path to get wrong — the contract is
        // explicit that there is no separate accept endpoint.
        onAccept: () => unawaited(
          _placeBid(sheetContext, request, request.proposedFareIqd),
        ),
        onCounter: (amount) => unawaited(
          _placeBid(sheetContext, request, amount),
        ),
        onReject: () => Navigator.of(sheetContext).pop(),
        onExpired: () {
          Navigator.of(sheetContext).pop();
          unawaited(_refresh());
        },
      ),
    );

    // The list is stale after any decision: this request may now be someone
    // else's ride.
    if (mounted) unawaited(_refresh());
  }

  Future<void> _placeBid(
    BuildContext sheetContext,
    OpenRideRequest request,
    int amountIqd,
  ) async {
    // A bid is a binding commitment at that fare. It deserves the same haptic
    // as accepting a dispatched offer, for the same reason: a driver commits
    // one-handed, in a moving car.
    unawaited(HapticFeedback.mediumImpact());
    setState(() => _submitting = true);

    try {
      await widget.api.placeBid(request.rideId, amountIqd: amountIqd);
      if (sheetContext.mounted) Navigator.of(sheetContext).pop();
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = switch (error.problem) {
          ApiProblem.conflict => AppStrings.of(context).rideNoLongerAvailable,
          ApiProblem.network => AppStrings.of(context).noInternet,
          // 422: outside the permitted band. The server's bound is the real
          // one; the sheet's slider is only a convenience.
          _ => error.detail ?? AppStrings.of(context).somethingWentWrong,
        };
      });
      if (sheetContext.mounted) Navigator.of(sheetContext).pop();
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(strings.openRequests)),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
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

            if (_blockers.isNotEmpty)
              AlyBlockerList(codes: _blockers)
            else if (_negotiationOff)
              AlyEmptyState(
                icon: Icons.gavel_rounded,
                title: strings.negotiationOff,
                message: strings.negotiationOffBody,
              )
            else if (_loading)
              const AlySkeletonRow()
            else if (_requests.isEmpty)
              AlyEmptyState(
                icon: Icons.local_taxi_rounded,
                title: strings.noOpenRequests,
                message: strings.noOpenRequestsBody,
              )
            else
              for (final request in _requests)
                Padding(
                  padding: const EdgeInsetsDirectional.only(
                    bottom: AlySpacing.md,
                  ),
                  child: _RequestCard(
                    request: request,
                    onBid: () => unawaited(_bid(request)),
                  ),
                ),
          ],
        ),
      ),
    );
  }
}

/// One open request, as a driver reads it: the price, then the distance to it.
class _RequestCard extends StatelessWidget {
  const _RequestCard({required this.request, required this.onBid});

  final OpenRideRequest request;
  final VoidCallback onBid;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final c = AlyColors.of(context);

    return AlyCard(
      onTap: onBid,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      strings.riderOffers,
                      style:
                          AlyTypography.label.copyWith(color: c.textSecondary),
                    ),
                    FareText(request.proposedFareIqd, large: true),
                  ],
                ),
              ),
              // The tariff's own number, where the server sent one. It is what
              // tells a driver whether the offer is fair without them having
              // to know the tariff by heart.
              if (request.suggestedFareIqd != null)
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      strings.estimatedFare,
                      style: AlyTypography.label
                          .copyWith(color: c.textSecondary),
                    ),
                    FareText(request.suggestedFareIqd!),
                  ],
                ),
            ],
          ),
          const SizedBox(height: AlySpacing.md),
          AlyRouteSummary(
            pickupAddress: request.pickupAddress,
            dropoffAddress: request.dropoffAddress,
          ),
          const SizedBox(height: AlySpacing.md),
          Text(
            '${strings.distanceToPickup}: '
            '${(request.distanceToPickupM / 1000).toStringAsFixed(1)} '
            '${strings.kilometreShort}',
            style: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
          ),
        ],
      ),
    );
  }
}
