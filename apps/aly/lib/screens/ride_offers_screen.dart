import 'dart:async';

import 'package:flutter/material.dart';
import 'package:rideapp_aly/screens/track_ride_screen.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The bids on the rider's own ride, cheapest first.
///
/// ## Why this screen exists now and not before
///
/// The server has served `/rides/{id}/bids` since migration 0012 and no Dart
/// client knew the route, so a feature that was designed, built, migrated and
/// documented was unreachable from the app. Nothing here is new API — see
/// `docs/api-contract.yaml`.
///
/// ## Why a 404 is not an error
///
/// Every negotiation route answers 404 when `platform_config.negotiation_enabled`
/// is off, and no endpoint reports that flag. So 404 means "this platform does
/// not negotiate", and the honest response is to leave: the ride is already
/// created and dispatch is proceeding the metered way. Showing "something went
/// wrong" for a platform that is working exactly as configured would send the
/// rider to support over nothing.
class RideOffersScreen extends StatefulWidget {
  const RideOffersScreen({required this.api, required this.ride, super.key});

  final ApiClient api;
  final Ride ride;

  @override
  State<RideOffersScreen> createState() => _RideOffersScreenState();
}

class _RideOffersScreenState extends State<RideOffersScreen> {
  RideBidsPage? _page;
  String? _error;
  String? _acceptingBidId;
  bool _negotiationOff = false;

  Timer? _poll;

  /// True until the first response lands, so the list shows a skeleton rather
  /// than "nobody replied" — a claim that cannot yet be made.
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
    // Bids arrive while the rider watches. Five seconds because a bid's whole
    // life is measured in tens of seconds, and a rider staring at a list that
    // updates once a minute assumes nobody answered.
    _poll = Timer.periodic(
      const Duration(seconds: 5),
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
      final page = await widget.api.rideBids(widget.ride.id);
      if (!mounted) return;
      setState(() {
        _page = page;
        _loading = false;
        _error = null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;

      if (error.problem == ApiProblem.notFound) {
        // Negotiation is disabled platform-wide. Not a failure — see the class
        // comment. Stop polling and hand the rider back to tracking.
        _poll?.cancel();
        setState(() {
          _negotiationOff = true;
          _loading = false;
        });
        return;
      }

      setState(() {
        _loading = false;
        _error = _messageFor(error);
      });
    }
  }

  Future<void> _accept(AlyDriverOffer offer) async {
    setState(() {
      _acceptingBidId = offer.offerId;
      _error = null;
    });

    try {
      final ride = await widget.api.acceptBid(widget.ride.id, offer.offerId);
      if (!mounted) return;

      _poll?.cancel();
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => TrackRideScreen(api: widget.api, ride: ride),
        ),
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _acceptingBidId = null;
        _error = _messageFor(error);
      });
      // The list is stale the moment an accept fails on a conflict: that
      // driver is gone. Refetch rather than leaving a card the rider will
      // press again.
      unawaited(_refresh());
    }
  }

  String _messageFor(ApiException error) {
    final strings = AppStrings.of(context);
    return switch (error.problem) {
      ApiProblem.network => strings.noInternet,
      ApiProblem.unauthorized => strings.sessionExpired,
      // The driver took another ride between the rider seeing the card and
      // pressing it. §5.1's claim is what decided, and it decided against us.
      ApiProblem.conflict ||
      ApiProblem.rideAlreadyClaimed =>
        strings.rideNoLongerAvailable,
      _ => strings.somethingWentWrong,
    };
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final page = _page;

    if (_negotiationOff) {
      // Replace, not pop. The ride EXISTS — it was created a moment ago — so
      // popping would return the rider to the request screen with a live ride
      // behind it. Metered dispatch is already running; tracking is the screen
      // that shows it.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        unawaited(
          Navigator.of(context).pushReplacement(
            MaterialPageRoute<void>(
              builder: (_) => TrackRideScreen(api: widget.api, ride: widget.ride),
            ),
          ),
        );
      });
    }

    return Scaffold(
      appBar: AppBar(title: Text(strings.searchingForDriver)),
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

          AlyOfferList(
            offers: _offers(page),
            riderProposalIqd: page?.proposedFareIqd ?? 0,
            isLoading: _loading,
            acceptingOfferId: _acceptingBidId,
            onAccept: (offer) => unawaited(_accept(offer)),
          ),
        ],
      ),
    );
  }

  /// Bids the rider can act on, cheapest first.
  ///
  /// Only ACTIVE ones. A superseded or expired bid is history — it is kept on
  /// the server because a fare dispute is argued from it, not because a rider
  /// should be able to press it.
  List<AlyDriverOffer> _offers(RideBidsPage? page) {
    if (page == null) return const [];

    final active = page.bids
        .where((bid) => bid.status == RideBidStatus.active)
        .toList()
      ..sort((a, b) => a.amountIqd.compareTo(b.amountIqd));

    return [
      for (final bid in active)
        if (bid.driver != null)
          AlyDriverOffer(
            offerId: bid.id,
            driver: bid.driver!,
            fareIqd: bid.amountIqd,
            // Absent ETA renders as zero rather than hiding the card: the fare
            // is the decision, and a driver who did not estimate their arrival
            // has still made a real offer.
            etaToPickup: bid.etaToPickup ?? Duration.zero,
          ),
    ];
  }
}
