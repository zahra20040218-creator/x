import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:rideapp_driver/location/location_service.dart';
import 'package:rideapp_driver/screens/offer_sheet.dart';
import 'package:rideapp_driver/screens/trip_screen.dart';

/// The driver's main screen: an online/offline switch and whatever ride is
/// currently live.
class DriverHomeScreen extends StatefulWidget {
  const DriverHomeScreen({
    required this.api,
    required this.location,
    super.key,
  });

  final ApiClient api;
  final DriverLocationService location;

  @override
  State<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends State<DriverHomeScreen> {
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
    return switch (error.problem) {
      ApiProblem.network => strings.noInternet,
      ApiProblem.unauthorized => strings.sessionExpired,
      ApiProblem.rideAlreadyClaimed => strings.rideNoLongerAvailable,
      ApiProblem.conflict => error.detail ?? strings.somethingWentWrong,
      ApiProblem.forbidden => strings.accountSuspended,
      _ => strings.somethingWentWrong,
    };
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
      appBar: AppBar(title: Text(strings.appNameDriver)),
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
