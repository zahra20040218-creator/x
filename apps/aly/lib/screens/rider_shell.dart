import 'dart:async';

import 'package:flutter/material.dart';
import 'package:rideapp_aly/screens/design_logic.dart';
import 'package:rideapp_aly/screens/profile_screen.dart';
import 'package:rideapp_aly/screens/request_ride_screen.dart';
import 'package:rideapp_aly/screens/ride_history_screen.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The rider's three destinations.
///
/// Three, not four. The fourth candidate was the wallet, and the wallet is a
/// DRIVER surface — `wallet()` and `walletEntries()` are driver routes, and a
/// rider in v1 pays cash and holds no balance. A tab that opens an empty
/// screen for every rider who taps it is worse than no tab.
///
/// Driver mode does not use this bar at all. CLAUDE.md §1.1 makes the mode a
/// server decision, and the driver console is a screen in its own right, not a
/// tab beside a passenger's trip history.
enum RiderTab { ride, trips, account }

/// The rider's app frame: the bar, and whichever destination is selected.
class RiderShell extends StatefulWidget {
  const RiderShell({required this.api, required this.onSignedOut, super.key});

  final ApiClient api;
  final VoidCallback onSignedOut;

  @override
  State<RiderShell> createState() => _RiderShellState();
}

class _RiderShellState extends State<RiderShell> {
  RiderTab _tab = RiderTab.ride;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final c = AlyColors.of(context);

    return Scaffold(
      backgroundColor: c.background,
      body: switch (_tab) {
        RiderTab.ride => RiderHomeDashboard(
            api: widget.api,
            onRequestRide: () => unawaited(_openRequest()),
            onOpenTrips: () => setState(() => _tab = RiderTab.trips),
          ),
        RiderTab.trips => RideHistoryScreen(api: widget.api),
        RiderTab.account => ProfileScreen(
            api: widget.api,
            onSignedOut: widget.onSignedOut,
          ),
      },
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab.index,
        onDestinationSelected: (index) =>
            setState(() => _tab = RiderTab.values[index]),
        backgroundColor: c.surface,
        indicatorColor: c.primaryMuted,
        destinations: [
          NavigationDestination(
            icon: const Icon(Icons.home_outlined),
            selectedIcon: const Icon(Icons.home_rounded),
            label: strings.navHome,
          ),
          NavigationDestination(
            icon: const Icon(Icons.receipt_long_outlined),
            selectedIcon: const Icon(Icons.receipt_long_rounded),
            label: strings.navTrips,
          ),
          NavigationDestination(
            icon: const Icon(Icons.person_outline_rounded),
            selectedIcon: const Icon(Icons.person_rounded),
            label: strings.navAccount,
          ),
        ],
      ),
    );
  }

  Future<void> _openRequest() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => RequestRideScreen(
          api: widget.api,
          onSignedOut: widget.onSignedOut,
        ),
      ),
    );
  }
}

/// The rider's home, screen 1 of the new design.
///
/// A dashboard rather than the map. The map moves to [RequestRideScreen],
/// which is the screen that needs it; putting it behind a tap costs the rider
/// one press and buys a home that can say something other than "where to?".
///
/// ## What is deliberately absent
///
/// The design carries a promotional banner ("استخدم الكود ALY20") and a
/// "become a driver — sign up now" card. Promo codes are on CLAUDE.md §2's
/// OUT list, and v1 has no driver self-signup for that button to open. Neither
/// is drawn here, and neither is replaced by an invented substitute: the
/// column simply starts at the services.
class RiderHomeDashboard extends StatefulWidget {
  const RiderHomeDashboard({
    required this.api,
    required this.onRequestRide,
    required this.onOpenTrips,
    super.key,
  });

  final ApiClient api;
  final VoidCallback onRequestRide;
  final VoidCallback onOpenTrips;

  @override
  State<RiderHomeDashboard> createState() => _RiderHomeDashboardState();
}

class _RiderHomeDashboardState extends State<RiderHomeDashboard> {
  Me? _me;
  List<Ride> _recent = const [];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final me = await widget.api.me();
      if (mounted) setState(() => _me = me);
    } on ApiException {
      // The greeting falls back to no name. A home screen that refuses to
      // render because it does not know who you are is worse than one that
      // says "good evening" and lets you order a car.
    }

    try {
      final rides = await widget.api.myRides();
      if (mounted) setState(() => _recent = rides);
    } on ApiException {
      // An empty recents list is the normal first-run state.
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final c = AlyColors.of(context);

    final greeting = switch (Greeting.forHour(DateTime.now().hour)) {
      Greeting.morning => strings.goodMorning,
      Greeting.evening => strings.goodEvening,
    };

    // Deduplicated by address, three at most — the same rule the request
    // screen's recents follow, for the same reason: a longer list pushes the
    // services off the first screenful.
    final destinations = <String>[];
    for (final ride in _recent) {
      final address = ride.dropoffAddress;
      if (address == null || address.isEmpty) continue;
      if (destinations.contains(address)) continue;
      destinations.add(address);
      if (destinations.length == 3) break;
    }

    return SafeArea(
      child: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        greeting,
                        style: AlyTypography.bodySmall
                            .copyWith(color: c.textSecondary),
                      ),
                      Text(
                        _me?.displayName ?? '',
                        style:
                            AlyTypography.h2.copyWith(color: c.textPrimary),
                      ),
                    ],
                  ),
                ),
                AlyAvatar(name: _me?.displayName ?? '؟'),
              ],
            ),

            const SizedBox(height: AlySpacing.xl),

            // The services. Two, because v1 has two: order a car, and look at
            // what you ordered before. A grid of one would be a list.
            Row(
              children: [
                Expanded(
                  child: _ServiceTile(
                    icon: Icons.directions_car_rounded,
                    label: strings.requestARide,
                    onTap: widget.onRequestRide,
                    emphasis: true,
                  ),
                ),
                const SizedBox(width: AlySpacing.md),
                Expanded(
                  child: _ServiceTile(
                    icon: Icons.receipt_long_rounded,
                    label: strings.navTrips,
                    onTap: widget.onOpenTrips,
                  ),
                ),
              ],
            ),

            if (destinations.isNotEmpty) ...[
              const SizedBox(height: AlySpacing.xl),
              Text(
                strings.recentDestinations,
                style: AlyTypography.label.copyWith(color: c.textSecondary),
              ),
              const SizedBox(height: AlySpacing.md),
              for (final address in destinations)
                Padding(
                  padding: const EdgeInsetsDirectional.only(
                    bottom: AlySpacing.sm,
                  ),
                  child: AlyCard(
                    onTap: widget.onRequestRide,
                    padding: const EdgeInsetsDirectional.all(AlySpacing.md),
                    child: Row(
                      children: [
                        Icon(Icons.history_rounded, color: c.textSecondary),
                        const SizedBox(width: AlySpacing.md),
                        Expanded(
                          child: Text(
                            address,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AlyTypography.body
                                .copyWith(color: c.textPrimary),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ServiceTile extends StatelessWidget {
  const _ServiceTile({
    required this.icon,
    required this.label,
    required this.onTap,
    this.emphasis = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  /// The primary action gets the filled surface. One per screen — a grid where
  /// everything is emphasised is a grid where nothing is.
  final bool emphasis;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return AlyCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: emphasis ? c.primary : c.primaryMuted,
              borderRadius: BorderRadius.circular(AlyRadius.md),
            ),
            child: Icon(icon, color: emphasis ? c.onPrimary : c.primary),
          ),
          const SizedBox(height: AlySpacing.md),
          Text(
            label,
            style: AlyTypography.title.copyWith(color: c.textPrimary),
          ),
        ],
      ),
    );
  }
}
