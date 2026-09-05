import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:rideapp_aly/location/location_service.dart';
import 'package:rideapp_aly/screens/earnings_screen.dart';
import 'package:rideapp_aly/screens/offer_sheet.dart';
import 'package:rideapp_aly/screens/subscription_screen.dart';
import 'package:rideapp_aly/screens/trip_screen.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The driver's main screen: an online/offline switch and whatever ride is
/// currently live.
class DriverHomeScreen extends StatefulWidget {
  const DriverHomeScreen({
    required this.api,
    required this.location,
    required this.onSignedOut,
    super.key,
  });

  final ApiClient api;
  final DriverLocationService location;

  /// Raised after the server has revoked the session.
  ///
  /// The driver app had no sign-out at all until now: a driver ending a shift,
  /// or handing the phone to someone else, stayed authenticated — and with
  /// push registered the next person would have received their ride offers.
  final VoidCallback onSignedOut;

  @override
  State<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends State<DriverHomeScreen> {
  bool _signingOut = false;

  /// Go offline first, then end the session.
  ///
  /// Order matters: a driver who signs out while still ONLINE keeps receiving
  /// offers from matching until the presence sweeper notices, and those offers
  /// go to a phone nobody is watching.
  Future<void> _signOut() async {
    setState(() => _signingOut = true);

    try {
      await widget.location.stop();
      await widget.api.setAvailability(availability: DriverAvailability.offline);
    } on Object {
      // Best effort. Failing to go offline must not trap the driver in a
      // session they asked to end - the presence sweeper evicts them anyway,
      // and the revocation below is what actually ends the session.
    }

    try {
      await widget.api.logout();
    } on ApiException {
      // Local tokens are cleared either way.
    }

    if (mounted) {
      setState(() => _signingOut = false);
      widget.onSignedOut();
    }
  }

  Me? _me;
  Ride? _activeRide;
  RideOffer? _offer;
  WalletBalance? _wallet;
  String? _error;
  bool _busy = false;

  Timer? _poll;
  RealtimeClient? _realtime;
  StreamSubscription<RealtimeEvent>? _realtimeEvents;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());

    // The socket is the primary path now. It was absent entirely: this screen
    // polled every 5 seconds against a 15-second offer expiry, so up to a third
    // of the window a driver has to decide was gone before the offer appeared.
    // Measured end to end after wiring the server side, an offer now arrives in
    // tens of milliseconds.
    _connectRealtime();

    // Kept as the fallback, at a longer interval. CLAUDE.md's reasoning about
    // Baghdad networks applies to a socket as much as to push: a driver whose
    // offers depend solely on a live connection is a driver who sometimes
    // receives none. 15s rather than 5 because the socket is now doing the
    // work, and a poll that duplicates it is load for nothing.
    _poll = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(_poll4Offer()));
  }

  void _connectRealtime() {
    final client = RealtimeClient(
      url: kRealtimeUrlFromEnv,
      tokenProvider: widget.api.currentAccessToken,
      // After a reconnect the driver may have been offered a ride during the
      // gap. The socket cannot replay it, so ask.
      onReconnect: () => unawaited(_poll4Offer()),
    );
    _realtime = client;
    _realtimeEvents = client.events.listen(_onRealtimeEvent);
    unawaited(client.connect());
  }

  void _onRealtimeEvent(RealtimeEvent event) {
    switch (event.type) {
      case 'ride.offer':
        // Fetch rather than trusting the payload: the offer carries ids and
        // timings, and the screen needs the full ride. This also means a
        // revoked offer is caught - the endpoint returns null for one that is
        // no longer current.
        unawaited(_poll4Offer());
      case 'ride.offer_revoked':
        if (mounted) setState(() => _offer = null);
      case 'ride.status_changed':
        unawaited(_refresh());
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    unawaited(_realtimeEvents?.cancel());
    unawaited(_realtime?.dispose());
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final me = await widget.api.me();
      final rides = await widget.api.myRides(limit: 5);
      final active = rides.where((r) => r.status.isActive).firstOrNull;

      if (!mounted) return;
      setState(() {
        _me = me;
        _activeRide = active;
        _error = null;
      });

      if (me.availability != DriverAvailability.offline) {
        unawaited(_loadWallet());
      }
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = _messageFor(error));
    }
  }

  Future<void> _loadWallet() async {
    try {
      final wallet = await widget.api.wallet();
      if (mounted) setState(() => _wallet = wallet);
    } on ApiException {
      // A wallet that fails to load is not worth interrupting a shift for.
    }
  }

  Future<void> _poll4Offer() async {
    if (_activeRide != null || _offer != null) return;
    if (_me?.availability != DriverAvailability.online) return;

    try {
      final offer = await widget.api.currentOffer();
      if (offer != null && mounted) {
        setState(() => _offer = offer);
        unawaited(_showOffer(offer));
      }
    } on ApiException {
      // Silent: this runs on a timer and on every socket event, and a
      // transient failure is normal.
    }
  }

  Future<void> _showOffer(RideOffer offer) async {
    final accepted = await showModalBottomSheet<bool>(
      context: context,
      isDismissible: false,
      enableDrag: false,
      isScrollControlled: true,
      builder: (_) => OfferSheet(offer: offer, api: widget.api),
    );

    if (!mounted) return;
    setState(() => _offer = null);

    if (accepted ?? false) {
      await _refresh();
    }
  }

  Future<void> _toggleOnline() async {
    final me = _me;
    if (me == null) return;

    setState(() => _busy = true);
    final strings = AppStrings.of(context);

    try {
      if (me.availability == DriverAvailability.offline) {
        // The permission and Doze-exemption flow must have completed, or the
        // service will stop minutes after the screen goes off and the driver
        // will not know why (CLAUDE.md §5.3).
        final started = await widget.location.start();
        if (!started) {
          if (mounted) {
            setState(() => _error = strings.backgroundLocationBody);
          }
          return;
        }

        final position = await _currentPosition();
        await widget.api.setAvailability(
          availability: DriverAvailability.online,
          position: position,
        );
      } else {
        await widget.api.setAvailability(availability: DriverAvailability.offline);
        await widget.location.stop();
      }

      await _refresh();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = _messageFor(error));
    } on Exception {
      // A position fix can time out indoors or with location services off.
      // Going online without one is worse than not going online at all.
      if (mounted) setState(() => _error = strings.locationPermissionBody);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The driver's position right now.
  ///
  /// Read from the device rather than defaulted. Going ONLINE without a real
  /// fix would put the driver in the geo set at the wrong place - they would
  /// appear online to themselves and be matched against somebody else's
  /// neighbourhood, or nobody's. There is deliberately no fallback coordinate:
  /// if there is no fix, going online fails and says so.
  Future<LatLng> _currentPosition() async {
    final position = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.high,
        timeLimit: Duration(seconds: 15),
      ),
    );
    return LatLng(lat: position.latitude, lng: position.longitude);
  }

  String _messageFor(ApiException error) {
    final strings = AppStrings.of(context);

    // Compliance is handled before the switch because it is the only refusal
    // that names something the driver can act on. "You cannot go online" tells
    // them nothing; "your licence expired" tells them where to go.
    final compliance = ComplianceFailure.from(error);
    if (compliance != null) return _complianceMessage(compliance, strings);

    // Every other reason driver mode is unavailable: unapproved, rejected,
    // suspended, subscription lapsed, or a code this build has never seen.
    //
    // The server has sent `driver-mode-unavailable` with a full blocker list
    // since 2026-08-25 and no Dart build knew the slug, so all of it fell
    // through to `somethingWentWrong`. A driver whose subscription expired was
    // told "something went wrong" — true, useless, and unactionable.
    //
    // Every blocker, not the first: a driver blocked for three reasons who
    // fixes one and is still blocked has learned nothing (CLAUDE.md §1.1).
    if (error.problem == ApiProblem.driverModeUnavailable) {
      final blockers = error.driverBlockers;
      if (blockers.isEmpty) return strings.cannotGoOnlineNow;

      final lines = <String>[strings.cannotGoOnlineNow];
      for (final code in blockers) {
        lines.add('${strings.blockerTitle(code)}: ${strings.blockerAction(code)}');
      }
      // The reason an operator gave, when there is one. It is the only part of
      // this message the driver could not have predicted.
      final suspended = error.suspendedReason;
      if (suspended != null && suspended.isNotEmpty) lines.add(suspended);

      return lines.join('\n');
    }

    return switch (error.problem) {
      ApiProblem.network => strings.noInternet,
      ApiProblem.unauthorized => strings.sessionExpired,
      ApiProblem.rideAlreadyClaimed => strings.rideNoLongerAvailable,
      ApiProblem.conflict => error.detail ?? strings.somethingWentWrong,
      ApiProblem.forbidden => strings.accountSuspended,
      _ => strings.somethingWentWrong,
    };
  }

  /// The three lists are kept apart on purpose: they send the driver to three
  /// different places. Missing means bring it in, expired means renew it first,
  /// rejected means the same document will not do and another trip with it is
  /// wasted.
  String _complianceMessage(ComplianceFailure failure, AppStrings strings) {
    if (failure.isUnexplained) {
      // The server named a document type this build does not know - possible
      // after a server deployment. Saying nothing would be worse.
      return '${strings.cannotGoOnline}\n${strings.documentsUnknownReason}';
    }

    final lines = <String>[strings.cannotGoOnline];

    void section(String heading, List<DriverDocumentType> types) {
      if (types.isEmpty) return;
      lines.add('$heading: ${types.map(strings.documentLabel).join('، ')}');
    }

    section(strings.documentsMissing, failure.missing);
    section(strings.documentsExpired, failure.expired);
    section(strings.documentsRejected, failure.rejected);

    return lines.join('\n');
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final me = _me;
    final ride = _activeRide;

    if (ride != null) {
      return TripScreen(
        api: widget.api,
        ride: ride,
        onFinished: () async {
          setState(() => _activeRide = null);
          await _refresh();
        },
      );
    }

    final isOnline = me?.availability == DriverAvailability.online;

    return Scaffold(
      appBar: AppBar(
        title: Text(strings.appNameDriver),
        actions: [
          IconButton(
            tooltip: strings.signOut,
            icon: const Icon(Icons.logout),
            onPressed: _signingOut ? null : _signOut,
          ),
          IconButton(
            tooltip: strings.earnings,
            icon: const Icon(Icons.account_balance_wallet_outlined),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => EarningsScreen(api: widget.api),
              ),
            ),
          ),
          IconButton(
            tooltip: strings.subscriptionTitle,
            icon: const Icon(Icons.card_membership_outlined),
            onPressed: () async {
              await Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => SubscriptionScreen(api: widget.api),
                ),
              );
              // Refresh on return. An operator may have activated the driver's
              // subscription while they were looking at the screen, and the
              // online toggle's blockers are computed from that.
              if (mounted) await _refresh();
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsetsDirectional.all(AppSpacing.md),
          children: [
            if (_error != null)
              StatusBanner(
                message: _error!,
                tone: BannerTone.danger,
                onRetry: _refresh,
              ),
            if (me?.isSuspended ?? false)
              StatusBanner(
                message: strings.accountSuspended,
                tone: BannerTone.danger,
              ),

            const SizedBox(height: AppSpacing.md),
            _OnlineCard(
              isOnline: isOnline,
              busy: _busy,
              onToggle: (me?.isSuspended ?? false) ? null : _toggleOnline,
            ),

            const SizedBox(height: AppSpacing.md),
            if (_wallet != null)
              Card(
                child: ListTile(
                  title: Text(strings.wallet),
                  subtitle: Text(strings.balance),
                  trailing: FareText(_wallet!.balanceIqd),
                ),
              ),

            // Buffered positions, surfaced so a driver can see that their
            // location is queued rather than lost when coverage is bad.
            if (widget.location.pendingCount > 0)
              Padding(
                padding: const EdgeInsetsDirectional.only(top: AppSpacing.md),
                child: StatusBanner(
                  message:
                      '${strings.bufferedLocations}: ${widget.location.pendingCount}',
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _OnlineCard extends StatelessWidget {
  const _OnlineCard({
    required this.isOnline,
    required this.busy,
    required this.onToggle,
  });

  final bool isOnline;
  final bool busy;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Card(
      child: Padding(
        padding: const EdgeInsetsDirectional.all(AppSpacing.lg),
        child: Column(
          children: [
            Container(
              width: 88,
              height: 88,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: (isOnline ? AppColors.online : AppColors.offline)
                    .withValues(alpha: 0.15),
              ),
              child: Icon(
                isOnline ? Icons.wifi_tethering : Icons.wifi_tethering_off,
                size: 44,
                color: isOnline ? AppColors.online : AppColors.offline,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              isOnline ? strings.youAreOnline : strings.youAreOffline,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: AppSpacing.lg),
            PrimaryButton(
              label: isOnline ? strings.goOffline : strings.goOnline,
              onPressed: onToggle,
              busy: busy,
              color: isOnline ? AppColors.danger : AppColors.online,
            ),
          ],
        ),
      ),
    );
  }
}
