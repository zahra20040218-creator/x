import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' as gmap;
import 'package:rideapp_aly/screens/profile_screen.dart';
import 'package:rideapp_aly/screens/ride_history_screen.dart';
import 'package:rideapp_aly/screens/ride_offers_screen.dart';
import 'package:rideapp_aly/screens/track_ride_screen.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The rider's home: a map, and a sheet that asks one question.
///
/// ## Why this screen holds no layout
///
/// Everything visible is [AlyRiderHome] in `packages/core`. This class is the
/// wiring: it owns the API calls, the location probe and the idempotency key,
/// and it renders the result as a [RiderHomeState]. The design system screen
/// takes that value and draws it.
///
/// The split is what makes the failure paths reachable. `AlyRiderHome` has
/// tests for "location refused", "offline" and "no drivers" because none of
/// them requires a server or a GPS fix — they are values. The screen this
/// replaced fetched its own data inside `build`, which is why its error states
/// had no tests at all.
///
/// ## The idempotency key, unchanged
///
/// CLAUDE.md §5.2:
///
///   "The rider app generates a UUID (Idempotency-Key header) per ride request
///    and retries with the same key on network failure."
///
/// The key is generated when the rider commits, and held for the whole retry
/// sequence. Generating a fresh key per attempt is the single most likely way
/// to get this wrong, and it produces exactly the failure the rule exists to
/// prevent: three taps through bad coverage, three rides, three drivers
/// dispatched. That logic is carried over from the previous screen verbatim.
class RequestRideScreen extends StatefulWidget {
  const RequestRideScreen({
    required this.api,
    required this.onSignedOut,
    super.key,
    this.gate = const GeolocatorLocationGate(),
  });

  final ApiClient api;

  /// Raised after the profile screen signs the rider out, so the app returns
  /// to the sign-in flow rather than sitting on a screen whose every request
  /// will now 401.
  final VoidCallback onSignedOut;

  /// Injected so a test can decide what the OS says about location without a
  /// device. See [LocationGate].
  final LocationGate gate;

  @override
  State<RequestRideScreen> createState() => _RequestRideScreenState();
}

class _RequestRideScreenState extends State<RequestRideScreen> {
  RiderHomeStage _stage = RiderHomeStage.idle;

  LatLng? _pickup;
  LatLng? _dropoff;
  String? _pickupAddress;
  String? _dropoffAddress;
  FareEstimate? _estimate;
  String? _error;
  bool _locationDenied = false;
  List<SavedPlace> _recent = const [];

  /// Held across retries of ONE rider intent. See [RideIntent].
  final RideIntent _intent = RideIntent();

  /// What the rider offered to pay, when they chose to name a price.
  ///
  /// Null means "take the meter", which is the default and the common case.
  /// The server ignores this entirely unless `platform_config.negotiation_enabled`
  /// is on, so sending it is safe on any platform.
  int? _proposedFareIqd;

  /// Set with `--dart-define=MAPS_CONFIGURED=true` in any build that also
  /// injects `-PMAPS_API_KEY`. Defaults to false so an unconfigured build says
  /// so plainly instead of rendering a blank grey rectangle.
  static const bool _mapsConfigured = bool.fromEnvironment('MAPS_CONFIGURED');

  /// Baghdad. The map's opening camera only — never a submitted coordinate.
  static const LatLng _baghdadCentre = LatLng(lat: 33.3152, lng: 44.3661);

  @override
  void initState() {
    super.initState();
    unawaited(_locateRider());
    unawaited(_loadRecentPlaces());
  }

  /// Where the rider is, so they do not have to tell us.
  ///
  /// A refusal is NOT an error: `locationDenied` renders the sheet's "we don't
  /// know where you are" notice, which offers both settings and picking the
  /// point by hand. The rider can still get a ride either way.
  Future<void> _locateRider() async {
    try {
      final serviceEnabled = await widget.gate.isLocationServiceEnabled();
      final permission = await widget.gate.requestPermission();

      final state = stateForPermission(
        serviceEnabled: serviceEnabled,
        permission: permission,
        hasApiKey: _mapsConfigured,
      );

      if (!mounted) return;

      if (state is! MapReady) {
        // Unavailable, disabled, denied and failed all land here. They differ
        // in how they are fixed, and `MapPickerView` says which when the rider
        // opens the picker; on the home sheet the one thing that matters is
        // that the pickup has to be chosen by hand.
        setState(() => _locationDenied = true);
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 15),
        ),
      );

      if (!mounted) return;
      setState(() {
        _locationDenied = false;
        _pickup = LatLng(lat: position.latitude, lng: position.longitude);
      });
    } on Exception {
      // A fix can time out indoors or with the radio off. Same outcome as a
      // refusal: the rider picks the point themselves.
      if (mounted) setState(() => _locationDenied = true);
    }
  }

  /// Recent destinations, from the rider's own completed rides.
  ///
  /// No new endpoint and no saved-places store: `myRides` already carries the
  /// dropoff of everywhere they have been, which is what the design's "وجهات
  /// سابقة" list is. Deduplicated by address so three trips home are one row.
  Future<void> _loadRecentPlaces() async {
    try {
      final rides = await widget.api.myRides();
      final seen = <String>{};
      final places = <SavedPlace>[];

      for (final ride in rides) {
        final address = ride.dropoffAddress;
        if (address == null || address.isEmpty) continue;
        if (!seen.add(address)) continue;
        places.add(SavedPlace(label: address, address: address));
        // Three, as the design caps it. A longer list pushes the sheet past
        // half the screen and buries the map.
        if (places.length == 3) break;
      }

      if (mounted) setState(() => _recent = places);
    } on ApiException {
      // An empty recents list is a normal first-run state, not a failure worth
      // interrupting the one thing this screen is for.
    }
  }

  /// Opens the map picker for the destination, then prices the trip.
  Future<void> _pickDestination() async {
    final picked = await Navigator.of(context).push<LatLng>(
      MaterialPageRoute<LatLng>(
        builder: (_) => MapPickerScreen(
          title: AppStrings.of(context).setDestination,
        ),
      ),
    );

    if (picked == null || !mounted) return;

    setState(() {
      _dropoff = picked;
      _dropoffAddress = null;
    });

    // No pickup yet means the rider refused location and has not set one, so
    // the destination alone cannot be priced. Ask for the pickup next rather
    // than silently doing nothing.
    if (_pickup == null) {
      await _pickPickup();
      return;
    }

    await _estimateFare();
  }

  Future<void> _pickPickup() async {
    final picked = await Navigator.of(context).push<LatLng>(
      MaterialPageRoute<LatLng>(
        builder: (_) => MapPickerScreen(
          title: AppStrings.of(context).setPickup,
        ),
      ),
    );

    if (picked == null || !mounted) return;

    setState(() {
      _pickup = picked;
      _pickupAddress = null;
      _locationDenied = false;
    });

    if (_dropoff != null) await _estimateFare();
  }

  Future<void> _estimateFare() async {
    final pickup = _pickup;
    final dropoff = _dropoff;
    if (pickup == null || dropoff == null) return;

    setState(() {
      _stage = RiderHomeStage.estimating;
      _error = null;
      // What is being asked for changed, so the previous intent is void.
      _intent.abandon();
    });

    try {
      final estimate = await widget.api.estimateFare(
        pickup: pickup,
        dropoff: dropoff,
      );
      if (!mounted) return;
      setState(() {
        _estimate = estimate;
        _stage = RiderHomeStage.readyToRequest;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _messageFor(error);
        // Back to idle, not stuck on a spinner: a fare that failed to price
        // leaves nothing to commit to.
        _stage = RiderHomeStage.idle;
      });
    }
  }

  /// Name a price instead of taking the meter's.
  ///
  /// The band is the design system's, anchored on the metered estimate: a
  /// rider must not be able to anchor at 500 IQD and a driver must not hold
  /// out for ten times the meter. The SERVER enforces the real bounds
  /// (`negotiation_band_bps`) — this only keeps the slider inside them so a
  /// rider is not offered a number that will be refused.
  Future<void> _proposeFare() async {
    final estimate = _estimate;
    if (estimate == null) return;

    final suggested = estimate.estimatedFareIqd.value;
    var chosen = suggested;

    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) {
        final strings = AppStrings.of(sheetContext);

        return SafeArea(
          child: StatefulBuilder(
            builder: (builderContext, setSheetState) => Padding(
              padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AlyFareProposal(
                    valueIqd: chosen,
                    suggestedIqd: suggested,
                    // ±40% around the meter. Wide enough to be a real
                    // negotiation, narrow enough that the server's own band
                    // rejects almost nothing the rider can reach here.
                    minIqd: (suggested * 0.6).round(),
                    maxIqd: (suggested * 1.4).round(),
                    onChanged: (value) => setSheetState(() => chosen = value),
                  ),
                  const SizedBox(height: AlySpacing.lg),
                  AlyButton(
                    label: strings.requestRide,
                    onPressed: () => Navigator.of(sheetContext).pop(true),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );

    if (confirmed != true || !mounted) return;

    setState(() => _proposedFareIqd = chosen);
    await _request();
  }

  Future<void> _request() async {
    final pickup = _pickup;
    final dropoff = _dropoff;
    if (pickup == null || dropoff == null) return;

    // ONE key per intent. Reused on every retry below.
    final key = _intent.beginAttempt();

    setState(() {
      _stage = RiderHomeStage.searching;
      _error = null;
    });

    try {
      final ride = await widget.api.createRide(
        pickup: pickup,
        dropoff: dropoff,
        idempotencyKey: key,
        proposedFareIqd: _proposedFareIqd,
      );

      if (!mounted) return;
      _intent.onSuccess();

      // A named price opens the ride to bids, so the rider goes to the offer
      // list. RideOffersScreen replaces itself with tracking if the platform
      // turns out not to negotiate — the ride is real either way.
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => _proposedFareIqd == null
              ? TrackRideScreen(api: widget.api, ride: ride)
              : RideOffersScreen(api: widget.api, ride: ride),
        ),
      );

      // Back from the trip: this rider is looking for their next one.
      if (mounted) _reset();
    } on ApiException catch (error) {
      if (!mounted) return;

      setState(() {
        _error = _messageFor(error);
        // The fare is still known, so the rider returns to a screen they can
        // commit from again rather than one they have to rebuild.
        _stage = _estimate == null
            ? RiderHomeStage.idle
            : RiderHomeStage.readyToRequest;
        // The key is deliberately KEPT for a retryable failure: the next
        // attempt must carry the same one, or it creates a second ride.
        _intent.onFailure(retryable: error.isRetryable);
      });
    }
  }

  void _reset() {
    setState(() {
      _stage = RiderHomeStage.idle;
      _dropoff = null;
      _dropoffAddress = null;
      _estimate = null;
      _error = null;
      _proposedFareIqd = null;
      _intent.abandon();
    });
    unawaited(_loadRecentPlaces());
  }

  String _messageFor(ApiException error) {
    final strings = AppStrings.of(context);
    return switch (error.problem) {
      ApiProblem.network => strings.noInternet,
      ApiProblem.unauthorized => strings.sessionExpired,
      // The server refused a second live ride. Telling the rider they already
      // have one is more useful than a generic conflict.
      ApiProblem.conflict => strings.youAlreadyHaveARide,
      ApiProblem.idempotencyInProgress => strings.searchingForDriver,
      _ => strings.somethingWentWrong,
    };
  }

  /// The menu the floating control opens.
  ///
  /// The screen this replaced carried an AppBar with two icon buttons. An
  /// AppBar takes a fixed strip off the top of the map in every state,
  /// including the one where the rider is watching a car approach, so the
  /// destinations move into a sheet reached from the single floating control.
  Future<void> _openMenu() async {
    final strings = AppStrings.of(context);

    await showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.receipt_long_rounded),
              title: Text(strings.rideHistory),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => RideHistoryScreen(api: widget.api),
                  ),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.person_rounded),
              title: Text(strings.profile),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => ProfileScreen(
                      api: widget.api,
                      onSignedOut: widget.onSignedOut,
                    ),
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlyRiderHome(
      state: RiderHomeState(
        stage: _stage,
        // Coordinates are the fallback, not the goal. There is no reverse
        // geocoder in this build, and a blank line where an address belongs
        // tells the rider less than the numbers do.
        pickupAddress: _pickupAddress ?? _describe(_pickup),
        dropoffAddress: _dropoffAddress ?? _describe(_dropoff),
        estimate: _estimate,
        errorMessage: _error,
        locationDenied: _locationDenied,
        recentPlaces: _recent,
      ),
      mapLayer: const _MapLayer(
        centre: _baghdadCentre,
        hasApiKey: _mapsConfigured,
      ),
      onSearchDestination: () => unawaited(_pickDestination()),
      onRequestRide: () => unawaited(_request()),
      // Rendered only when there is a fare to negotiate around. Null on every
      // other stage, which is what keeps the meter the default.
      onProposeFare:
          _estimate == null ? null : () => unawaited(_proposeFare()),
      onCancel: _reset,
      onRetry: () => unawaited(
        _estimate == null ? _estimateFare() : _request(),
      ),
      onEnableLocation: () => unawaited(_pickPickup()),
      onOpenMenu: () => unawaited(_openMenu()),
      // A recent row names a place, not a coordinate. Until there is a
      // geocoder to turn one back into the other, tapping one opens the picker
      // rather than pretending to know where it was.
      onPickRecent: (_) => unawaited(_pickDestination()),
    );
  }

  String? _describe(LatLng? point) => point == null
      ? null
      : '${point.lat.toStringAsFixed(4)}, ${point.lng.toStringAsFixed(4)}';
}

/// The map behind the sheet.
///
/// Read-only: the home map is context, not a control. Picking a point happens
/// in [MapPickerScreen], which is a separate screen with a confirm step,
/// because a coordinate the rider is about to be charged for should never be
/// set by an accidental pan.
class _MapLayer extends StatelessWidget {
  const _MapLayer({required this.centre, required this.hasApiKey});

  final LatLng centre;
  final bool hasApiKey;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    if (!hasApiKey) {
      // Not an error the rider can fix, and not worth an alarming colour: the
      // sheet in front of this still does everything. A plain surface reads as
      // "no map here", which is true, where a red failure would read as "the
      // app is broken", which is not.
      return ColoredBox(color: c.surfaceSunken);
    }

    return gmap.GoogleMap(
      initialCameraPosition: gmap.CameraPosition(
        target: gmap.LatLng(centre.lat, centre.lng),
        zoom: 15,
      ),
      myLocationEnabled: true,
      myLocationButtonEnabled: false,
      // The sheet sits over the bottom half, so Google's own controls would be
      // behind it.
      zoomControlsEnabled: false,
      mapToolbarEnabled: false,
    );
  }
}

/// Picks one coordinate on a full-screen map.
///
/// Kept as its own screen so the request flow above — which is where the
/// idempotency behaviour lives — can be reasoned about and tested without a
/// map SDK or an API key.
class MapPickerScreen extends StatelessWidget {
  const MapPickerScreen({required this.title, super.key});

  final String title;

  /// Set with `--dart-define=MAPS_CONFIGURED=true` in any build that also
  /// injects `-PMAPS_API_KEY`. Defaults to false so an unconfigured build
  /// says so plainly.
  static const bool _mapsConfigured = bool.fromEnvironment('MAPS_CONFIGURED');

  /// Baghdad. A starting camera position only, never a submitted coordinate —
  /// the user must move the map and confirm.
  static const LatLng _baghdadCentre = LatLng(lat: 33.3152, lng: 44.3661);

  @override
  Widget build(BuildContext context) => MapPickerView(
        title: title,
        initialCentre: _baghdadCentre,
        hasApiKey: _mapsConfigured,
        onConfirm: (picked) => Navigator.of(context).pop(picked),
      );
}

/// One rider intent, and the key that makes retrying it safe.
///
/// CLAUDE.md §5.2 in a form a test can reach. The rule is three lines and all
/// three matter:
///
/// - The key is minted once, on the first attempt, and returned unchanged by
///   every later attempt. A fresh key per attempt is the mistake the rule
///   exists to prevent: three taps through bad coverage become three rides and
///   three drivers dispatched.
/// - A RETRYABLE failure keeps it. The next attempt must carry the same key or
///   the server has no way to recognise it as the same request.
/// - Success, and any failure that is not retryable, clears it. The next tap
///   is then a genuinely new request rather than a duplicate of a dead one.
///
/// It lived inside the screen's State, where nothing could test it. It is the
/// most consequential rule on this screen and it now has its own tests.
class RideIntent {
  RideIntent({String Function()? mintKey})
      : _mint = mintKey ?? ApiClient.newIdempotencyKey;

  final String Function() _mint;

  String? _key;

  /// The key for this attempt: the existing one, or a new one if this is the
  /// first attempt of a fresh intent.
  String beginAttempt() => _key ??= _mint();

  /// True while an intent is live and its key must be reused.
  bool get isLive => _key != null;

  void onSuccess() => _key = null;

  void onFailure({required bool retryable}) {
    if (!retryable) _key = null;
  }

  /// The rider changed what they are asking for, so the old intent is void.
  void abandon() => _key = null;
}
