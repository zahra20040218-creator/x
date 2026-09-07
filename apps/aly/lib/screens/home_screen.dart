import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:rideapp_aly/location/location_service.dart';
import 'package:rideapp_aly/screens/design_logic.dart';
import 'package:rideapp_aly/screens/earnings_screen.dart';
import 'package:rideapp_aly/screens/offer_sheet.dart';
import 'package:rideapp_aly/screens/open_requests_screen.dart';
import 'package:rideapp_aly/screens/profile_screen.dart';
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
  String? _error;
  bool _busy = false;

  /// What the server says this account may do (CLAUDE.md §1.1). The blockers
  /// drive [AlyBlockerList] and decide whether [AlyOnlineToggle] is pressable —
  /// the screen decides nothing itself.
  Capabilities? _capabilities;

  /// The driver's own subscription, plus the plan's display name resolved
  /// against the catalogue. Both null when the driver has never bought one.
  DriverSubscription? _subscription;
  String? _planName;

  /// Today's earnings, derived from the statement page (see [EarningsSummary] —
  /// summing every ledger row would double-count).
  EarningsSummary? _earnings;

  /// When this app instance first saw the driver online.
  ///
  /// Session-local, and deliberately not persisted or invented: the server has
  /// no online-time field, and [AlyEarningsCard] needs a `Duration`. A driver
  /// who restarts the app mid-shift sees the count restart. Making this
  /// accurate needs a server-side shift clock — see DEFECTS.md D-10.
  DateTime? _onlineSince;

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
      // Together, not one after the other. The two are independent, and on a
      // Baghdad mobile link each round trip is most of a second — sequencing
      // them doubled the time before the console had anything to draw.
      final results = await Future.wait<Object>([
        widget.api.me(),
        widget.api.myRides(limit: 5),
      ]);
      final me = results[0] as Me;
      final rides = results[1] as List<Ride>;
      final active = rides.where((r) => r.status.isActive).firstOrNull;

      if (!mounted) return;
      setState(() {
        _me = me;
        _activeRide = active;
        _error = null;
        // Started here rather than in the toggle: a driver who was already
        // online when the app opened would otherwise never get a clock at all.
        if (me.availability == DriverAvailability.online) {
          _onlineSince ??= DateTime.now();
        } else {
          _onlineSince = null;
        }
      });

      // The console's three cards. Each is unawaited and individually
      // tolerant: none of them is worth failing a shift over, and a driver
      // whose subscription endpoint is slow still gets the online toggle.
      unawaited(_loadCapabilities());
      unawaited(_loadSubscription());
      unawaited(_loadEarnings());
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = _messageFor(error));
    }
  }

  Future<void> _loadCapabilities() async {
    try {
      final capabilities = await widget.api.capabilities();
      if (mounted) setState(() => _capabilities = capabilities);
    } on ApiException {
      // Left null, which renders no blocker list at all. Guessing "blocked"
      // from a failed request would strand a driver who is perfectly able to
      // work; the server refuses the availability call anyway if they are not.
    }
  }

  Future<void> _loadSubscription() async {
    try {
      final subscription = await widget.api.mySubscription();
      if (subscription == null) {
        if (mounted) {
          setState(() {
            _subscription = null;
            _planName = null;
          });
        }
        return;
      }

      // The plan's own name where the catalogue still lists it, falling back
      // to the stored code — a driver whose plan was withdrawn after they
      // bought it still holds a valid period.
      var name = subscription.planCode;
      try {
        final plans = await widget.api.subscriptionPlans();
        final language = mounted ? AppStrings.of(context).languageCode : 'ar';
        for (final plan in plans) {
          if (plan.code == subscription.planCode) name = plan.nameFor(language);
        }
      } on ApiException {
        // Keep the code as the name.
      }

      if (mounted) {
        setState(() {
          _subscription = subscription;
          _planName = name;
        });
      }
    } on ApiException {
      // No card rather than a wrong one.
    }
  }

  /// Where a blocker row sends the driver.
  ///
  /// Only the one blocker that has somewhere to go is routed. Every other
  /// reason is resolved by an operator, and [AlyBlockerList] already states
  /// what to do — a button that goes nowhere is worse than a sentence that
  /// explains. Document upload is not a screen this build has (CLAUDE.md §2:
  /// approved, not yet built), so it is not routed either.
  void _onBlockerAction(String code) {
    if (code == 'SUBSCRIPTION_REQUIRED') unawaited(_openSubscription());
  }

  Future<void> _openSubscription() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SubscriptionScreen(api: widget.api),
      ),
    );
    // Refresh on return. An operator may have activated the driver's
    // subscription while they were looking at the screen, and the online
    // toggle's blockers are computed from that.
    if (mounted) await _refresh();
  }

  Future<void> _loadEarnings() async {
    try {
      final page = await widget.api.walletEntries();
      if (mounted) setState(() => _earnings = EarningsSummary.from(page.items));
    } on ApiException {
      // The earnings card is hidden until it has real numbers.
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
    // Going online or offline is the driver's most consequential tap, and the
    // request that confirms it can take a second on a bad connection.
    unawaited(HapticFeedback.selectionClick());
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
    final ride = _activeRide;

    // Accepting a ride replaced the whole screen in a single frame. It is the
    // largest state change in the app and it read as a glitch — a driver who
    // taps accept should see the console leave and the trip arrive, so they
    // know which of the two they are looking at.
    //
    // Keys are what make the switch a switch: without them the framework sees
    // one subtree being rebuilt and cross-fades nothing.
    return AnimatedSwitcher(
      duration: AlyMotion.respecting(context, AlyMotion.medium),
      switchInCurve: AlyMotion.enter,
      switchOutCurve: AlyMotion.exit,
      child: ride != null
          ? TripScreen(
              key: const ValueKey<String>('trip'),
              api: widget.api,
              ride: ride,
              onFinished: () async {
                setState(() => _activeRide = null);
                await _refresh();
              },
            )
          : _console(context),
    );
  }

  /// The driver console: the toggle, and what the server says about this shift.
  Widget _console(BuildContext context) {
    final strings = AppStrings.of(context);
    final me = _me;

    final isOnline = me?.availability == DriverAvailability.online;
    final earnings = _earnings;
    final subscription = _subscription;

    final greeting = switch (Greeting.forHour(DateTime.now().hour)) {
      Greeting.morning => strings.goodMorning,
      Greeting.evening => strings.goodEvening,
    };

    // The server's list, verbatim. A suspended account is a blocker the
    // server also reports, so the local flag only ever adds to it.
    final blockers = <String>[
      ...?_capabilities?.driver.blockers,
      if ((me?.isSuspended ?? false) &&
          !(_capabilities?.driver.blockers.contains('SUSPENDED') ?? false))
        'SUSPENDED',
    ];
    final blocked = blockers.isNotEmpty;

    // Only ever the current stretch — see [_onlineSince].
    final onlineTime = _onlineSince == null
        ? Duration.zero
        : DateTime.now().difference(_onlineSince!);

    return Scaffold(
      key: const ValueKey<String>('console'),
      appBar: AppBar(
        title: Text(strings.appNameDriver),
        actions: [
          IconButton(
            tooltip: strings.signOut,
            icon: const Icon(Icons.logout_rounded),
            onPressed: _signingOut ? null : _signOut,
          ),
          // Bidding lives beside the console rather than inside it: a driver
          // either waits for a dispatched offer or goes looking for one, and
          // the two are different intents. Opens for every driver — the screen
          // itself reports 404 as "this platform does not negotiate", which is
          // the only signal the contract gives.
          IconButton(
            tooltip: strings.openRequests,
            icon: const Icon(Icons.gavel_rounded),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => OpenRequestsScreen(api: widget.api),
              ),
            ),
          ),
          IconButton(
            tooltip: strings.earnings,
            icon: const Icon(Icons.account_balance_wallet_rounded),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => EarningsScreen(api: widget.api),
              ),
            ),
          ),
          IconButton(
            tooltip: strings.profile,
            icon: const Icon(Icons.person_rounded),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ProfileScreen(
                  api: widget.api,
                  onSignedOut: widget.onSignedOut,
                ),
              ),
            ),
          ),
          IconButton(
            tooltip: strings.subscriptionTitle,
            icon: const Icon(Icons.card_membership_rounded),
            onPressed: () => unawaited(_openSubscription()),
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

            const SizedBox(height: AlySpacing.lg),

            // Who is working, and how they are regarded. The rating sits here
            // rather than in the profile because it is the number a driver
            // checks between rides, and it is one line.
            Row(
              children: [
                AlyAvatar(name: me?.displayName ?? '؟'),
                const SizedBox(width: AlySpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        greeting,
                        style: AlyTypography.bodySmall
                            .copyWith(color: AlyColors.of(context).textSecondary),
                      ),
                      Text(
                        me?.displayName ?? '',
                        style: AlyTypography.h3
                            .copyWith(color: AlyColors.of(context).textPrimary),
                      ),
                    ],
                  ),
                ),
                if (me?.rating != null) AlyRatingStars(value: me!.rating!),
              ],
            ),

            const SizedBox(height: AlySpacing.lg),
            // The one saturated fill on the screen. `onChanged` is null — not
            // a hidden button — whenever the server says this driver may not
            // go online: CLAUDE.md §1.1, hiding a control is not authorisation.
            AlyOnlineToggle(
              isOnline: isOnline,
              isBusy: _busy,
              onChanged: blocked ? null : (_) => unawaited(_toggleOnline()),
            ),

            // Every reason, in the server's order, each naming its next step.
            if (blockers.isNotEmpty) ...[
              const SizedBox(height: AlySpacing.lg),
              AlyBlockerList(
                codes: blockers,
                onAction: _onBlockerAction,
              ),
            ],

            if (earnings != null) ...[
              const SizedBox(height: AlySpacing.lg),
              AlyEarningsCard(
                todayIqd: earnings.today,
                tripCount: earnings.rideCount,
                onlineTime: onlineTime,
                // No yesterday figure exists server-side, and an invented
                // comparison is worse than none — the card hides it on null.
                onViewStatement: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => EarningsScreen(api: widget.api),
                  ),
                ),
              ),
            ],

            if (subscription != null) ...[
              const SizedBox(height: AlySpacing.lg),
              AlySubscriptionCard(
                planName: _planName ?? subscription.planCode,
                expiresAt: subscription.expiresAt,
                // Against the real clock, so a console left open overnight
                // does not keep showing yesterday's number.
                daysRemaining: subscription.daysRemainingAt(DateTime.now()),
                onRenew: () => unawaited(_openSubscription()),
              ),
            ],

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
