import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:rideapp_core/rideapp_core.dart';

import 'earnings_screen.dart';
import 'package:rideapp_driver/location/location_service.dart';
import 'package:rideapp_driver/screens/offer_sheet.dart';
import 'package:rideapp_driver/screens/trip_screen.dart';

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

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());

    // The polling fallback. Push is the primary path, but CLAUDE.md's own
    // reasoning about Baghdad networks applies to FCM too - an offer that
    // depends solely on push arriving is an offer that sometimes never arrives.
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => unawaited(_poll4Offer()));
  }

  @override
  void dispose() {
    _poll?.cancel();
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
      // Silent: this runs every 5 seconds and a transient failure is normal.
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
                  tone: BannerTone.info,
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
