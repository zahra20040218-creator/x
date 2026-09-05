import 'package:flutter/material.dart';
import 'package:rideapp_core/src/design/components/buttons.dart';
import 'package:rideapp_core/src/design/components/inputs.dart';
import 'package:rideapp_core/src/design/components/ride.dart';
import 'package:rideapp_core/src/design/components/states.dart';
import 'package:rideapp_core/src/design/tokens/colors.dart';
import 'package:rideapp_core/src/design/tokens/metrics.dart';
import 'package:rideapp_core/src/design/tokens/typography.dart';
import 'package:rideapp_core/src/design/widgets.dart';
import 'package:rideapp_core/src/models/models.dart';

/// The rider's home.
///
/// ## What this screen is for
///
/// One thing: getting a ride. A rider opens ALY because they want to be
/// somewhere else, and every pixel that does not serve that is in the way.
///
/// That is why this is a map with a sheet over it and not a dashboard. The map
/// answers "where am I" without being asked; the sheet answers "where to?" and
/// nothing else. Trip history, the profile and the wallet are all real things a
/// rider needs occasionally, and none of them belongs on the screen they open
/// twice a day to do one task.
///
/// ## The layering, and why it is this way round
///
/// The map is the full-bleed background, not a widget inside a column. During
/// an active trip the rider is watching a car move; a sheet that covers the map
/// leaves them unable to see the thing they opened the app for. So the sheet
/// never exceeds roughly half the height, and the map keeps the top half in
/// every state.
///
/// ## Why the screen owns no data
///
/// Everything here is driven by `state` and the callbacks. It does not know
/// about `ApiClient`, does not fetch, and does not hold a timer. That is what
/// makes every state below reachable in a test - including the ones that are
/// hard to produce against a live server, like "GPS refused" and "no drivers".
///
/// The alternative, a screen that fetches its own data, is the reason the old
/// rider screens have no tests for their failure paths: there was no way to
/// reach them.

/// Where the rider is in the business of getting a ride.
enum RiderHomeStage {
  /// Nothing requested. The map, and a prompt to name a destination.
  idle,

  /// A destination is set and a fare is being estimated.
  estimating,

  /// A fare is known and the rider can commit.
  readyToRequest,

  /// Requested; drivers are being found or are bidding.
  searching,

  /// A ride is live. The sheet becomes the trip.
  onTrip,
}

/// Everything the home screen renders, in one value.
///
/// A single object rather than a dozen nullable fields, so an impossible
/// combination - a fare estimate with no destination, say - cannot be
/// constructed by a caller that forgot to clear one of them.
@immutable
class RiderHomeState {
  const RiderHomeState({
    this.stage = RiderHomeStage.idle,
    this.pickupAddress,
    this.dropoffAddress,
    this.estimate,
    this.ride,
    this.driver,
    this.errorMessage,
    this.locationDenied = false,
    this.offline = false,
    this.zoneAvailable = true,
    this.recentPlaces = const <SavedPlace>[],
  });

  final RiderHomeStage stage;
  final String? pickupAddress;
  final String? dropoffAddress;
  final FareEstimate? estimate;
  final Ride? ride;
  final PublicUser? driver;

  /// A message the rider can act on. Never a status code, never an exception.
  final String? errorMessage;

  /// The permission was refused. This is NOT an error state - the rider made a
  /// choice, and the screen has to keep working without it.
  final bool locationDenied;

  final bool offline;

  /// ALY opens district by district. Outside a live zone the rider is told so
  /// and offered the alternative, rather than being allowed to request a ride
  /// that nobody can serve.
  final bool zoneAvailable;

  final List<SavedPlace> recentPlaces;
}

/// A place the rider has been, or has saved.
@immutable
class SavedPlace {
  const SavedPlace({required this.label, required this.address, this.isSaved = false});

  final String label;
  final String address;
  final bool isSaved;
}

/// The rider's home screen.
class AlyRiderHome extends StatelessWidget {
  const AlyRiderHome({
    required this.state,
    required this.mapLayer,
    required this.onSearchDestination,
    required this.onRequestRide,
    required this.onCancel,
    required this.onRetry,
    required this.onEnableLocation,
    required this.onOpenMenu,
    super.key,
    this.onPickRecent,
  });

  final RiderHomeState state;

  /// The map, injected rather than constructed here.
  ///
  /// `google_maps_flutter` needs a platform view and an API key, neither of
  /// which exists in a widget test. Injecting it means every state below is
  /// testable, and it also means the screen does not care which map provider
  /// ships - which is a decision that should not be welded into a layout.
  final Widget mapLayer;

  final VoidCallback onSearchDestination;
  final VoidCallback onRequestRide;
  final VoidCallback onCancel;
  final VoidCallback onRetry;
  final VoidCallback onEnableLocation;
  final VoidCallback onOpenMenu;
  final ValueChanged<SavedPlace>? onPickRecent;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Scaffold(
      backgroundColor: c.background,
      body: Stack(
        children: [
          // Full bleed, behind everything.
          Positioned.fill(child: mapLayer),

          // Top controls float over the map rather than sitting in an app bar.
          // An AppBar would eat a fixed strip of the map in every state,
          // including the one where the rider is watching a car approach.
          SafeArea(
            child: Padding(
              padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      _FloatingControl(
                        icon: Icons.menu_rounded,
                        semanticLabel: 'القائمة',
                        onTap: onOpenMenu,
                      ),
                      const Spacer(),
                      if (state.offline) const Expanded(flex: 4, child: AlyOfflineBanner()),
                    ],
                  ),
                ],
              ),
            ),
          ),

          // The sheet. Bottom-anchored, never more than half the screen, so the
          // map stays legible in every state.
          Align(
            alignment: Alignment.bottomCenter,
            child: SafeArea(
              top: false,
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * 0.55,
                ),
                child: _HomeSheet(
                  state: state,
                  onSearchDestination: onSearchDestination,
                  onRequestRide: onRequestRide,
                  onCancel: onCancel,
                  onRetry: onRetry,
                  onEnableLocation: onEnableLocation,
                  onPickRecent: onPickRecent,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// A control that floats over the map.
class _FloatingControl extends StatelessWidget {
  const _FloatingControl({
    required this.icon,
    required this.semanticLabel,
    required this.onTap,
  });

  final IconData icon;
  final String semanticLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Semantics(
      button: true,
      label: semanticLabel,
      child: Material(
        color: c.surface,
        shape: const CircleBorder(),
        // Elevation here is load-bearing rather than decorative: it is what
        // separates the control from whatever the map happens to be showing
        // underneath it, which could be any colour.
        elevation: c.brightness == Brightness.dark ? 0 : 3,
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: SizedBox(
            width: AlySpacing.tapTargetSmall,
            height: AlySpacing.tapTargetSmall,
            child: Icon(icon, color: c.textPrimary, size: 22),
          ),
        ),
      ),
    );
  }
}

/// The sheet, which is the whole interaction.
class _HomeSheet extends StatelessWidget {
  const _HomeSheet({
    required this.state,
    required this.onSearchDestination,
    required this.onRequestRide,
    required this.onCancel,
    required this.onRetry,
    required this.onEnableLocation,
    required this.onPickRecent,
  });

  final RiderHomeState state;
  final VoidCallback onSearchDestination;
  final VoidCallback onRequestRide;
  final VoidCallback onCancel;
  final VoidCallback onRetry;
  final VoidCallback onEnableLocation;
  final ValueChanged<SavedPlace>? onPickRecent;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(AlyRadius.sheet)),
        boxShadow: c.brightness == Brightness.dark ? AlyElevation.none : AlyElevation.high,
      ),
      child: SingleChildScrollView(
        padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            // The grab handle. Not decoration: it is the only affordance that
            // says this panel moves.
            Center(
              child: Container(
                width: 36,
                height: 4,
                margin: const EdgeInsetsDirectional.only(bottom: AlySpacing.lg),
                decoration: BoxDecoration(
                  color: c.border,
                  borderRadius: BorderRadius.circular(AlyRadius.pill),
                ),
              ),
            ),
            ..._body(context),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(BuildContext context) {
    final c = AlyColors.of(context);

    // Order matters. A blocked zone outranks everything - there is no point
    // estimating a fare for a trip nobody can serve - and an error outranks the
    // ordinary stages, because the rider needs to know why nothing happened.
    if (!state.zoneAvailable) {
      return [
        AlyEmptyState(
          icon: Icons.location_off_rounded,
          title: 'ALY لا يعمل في هذه المنطقة بعد',
          message:
              'نحن نفتح بغداد منطقة بعد منطقة. أخبرنا أين تحتاجنا وسنصلك عند '
              'افتتاح منطقتك.',
          actionLabel: 'أبلغني عند الافتتاح',
          onAction: onRetry,
        ),
      ];
    }

    if (state.errorMessage != null) {
      return [
        AlyErrorState(
          title: 'تعذّر إكمال الطلب',
          message: state.errorMessage!,
          onRetry: onRetry,
        ),
      ];
    }

    switch (state.stage) {
      case RiderHomeStage.idle:
        return _idle(context);
      case RiderHomeStage.estimating:
        return _estimating(context);
      case RiderHomeStage.readyToRequest:
        return _ready(context);
      case RiderHomeStage.searching:
        return _searching(context);
      case RiderHomeStage.onTrip:
        return _onTrip(context, c);
    }
  }

  // -------------------------------------------------------------------------

  List<Widget> _idle(BuildContext context) {
    final c = AlyColors.of(context);

    return [
      Text('إلى أين؟', style: AlyTypography.h2.copyWith(color: c.textPrimary)),
      const SizedBox(height: AlySpacing.lg),

      // A button that LOOKS like a field, not a real one.
      //
      // Tapping it opens the destination screen, which has recents, saved
      // places and map selection. A live text field here would put a keyboard
      // over the map to do a job the full screen does better, and it would
      // still need the full screen for everything except typing.
      Semantics(
        button: true,
        label: 'اختيار الوجهة',
        child: InkWell(
          onTap: onSearchDestination,
          borderRadius: BorderRadius.circular(AlyRadius.sm),
          child: IgnorePointer(
            child: AlySearchField(
              controller: TextEditingController(text: state.dropoffAddress ?? ''),
              enabled: false,
            ),
          ),
        ),
      ),

      if (state.locationDenied) ...[
        const SizedBox(height: AlySpacing.lg),
        // Not an error. The rider made a choice; the screen keeps working and
        // explains what it costs them.
        _Notice(
          icon: Icons.my_location_rounded,
          title: 'لا نعرف مكانك',
          message: 'فعّل الموقع لنحدد نقطة انطلاقك تلقائياً، أو اخترها على الخريطة.',
          actionLabel: 'تفعيل الموقع',
          onAction: onEnableLocation,
        ),
      ],

      if (state.recentPlaces.isNotEmpty) ...[
        const SizedBox(height: AlySpacing.xl),
        Text('وجهات سابقة', style: AlyTypography.label.copyWith(color: c.textSecondary)),
        const SizedBox(height: AlySpacing.sm),
        // Capped at three. The list is a shortcut, not a history screen - a
        // rider scanning ten rows is slower than one typing.
        for (final place in state.recentPlaces.take(3))
          _RecentRow(place: place, onTap: () => onPickRecent?.call(place)),
      ],
    ];
  }

  List<Widget> _estimating(BuildContext context) => [
        // Skeletons, not a spinner. The shape of what is coming is itself
        // information, and it stops the sheet resizing when the fare lands.
        const AlySkeleton(height: 20, width: 140),
        const SizedBox(height: AlySpacing.md),
        const AlySkeleton(height: 44),
        const SizedBox(height: AlySpacing.lg),
        const AlySkeleton(height: AlySpacing.tapTarget),
      ];

  List<Widget> _ready(BuildContext context) {
    final c = AlyColors.of(context);
    final estimate = state.estimate;

    return [
      AlyRouteSummary(
        pickupAddress: state.pickupAddress ?? 'موقعك الحالي',
        dropoffAddress: state.dropoffAddress ?? '',
      ),
      const SizedBox(height: AlySpacing.lg),
      if (estimate != null) ...[
        // The label yields, the number does not.
        //
        // `Spacer` between two natural-width children overflowed by 98 pixels
        // at the default size and worse at 1.8x: neither child could shrink, so
        // the Row simply ran out of width. Making the LABEL flexible is the
        // right way round - it is secondary text that can wrap or ellipsize,
        // while the fare is the number the rider is deciding on and must never
        // be truncated.
        // Label and fare share a line while they fit, and stack when they do
        // not. `Wrap` rather than a breakpoint, because the trigger is text
        // scale times the width of a five-digit fare, which no screen-size
        // guess predicts. Making the label `Expanded` was not enough: at 1.8x
        // the fare alone is wider than the sheet, so there was nothing left to
        // shrink.
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.end,
          spacing: AlySpacing.md,
          runSpacing: AlySpacing.xs,
          children: [
            Text(
              'الأجرة التقديرية',
              style: AlyTypography.body.copyWith(color: c.textSecondary),
            ),
            FareText(estimate.estimatedFareIqd, large: true),
          ],
        ),
        const SizedBox(height: AlySpacing.xs),
        Text(
          'السعر النهائي قد يختلف حسب الطريق الفعلي.',
          style: AlyTypography.caption.copyWith(color: c.textTertiary),
        ),
      ],
      const SizedBox(height: AlySpacing.xl),
      AlyButton(label: 'اطلب الرحلة', onPressed: onRequestRide),
    ];
  }

  List<Widget> _searching(BuildContext context) {
    final c = AlyColors.of(context);

    return [
      Row(
        children: [
          SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2, color: c.primary),
          ),
          const SizedBox(width: AlySpacing.md),
          Expanded(
            child: Text(
              'نبحث عن سائق قريب…',
              style: AlyTypography.title.copyWith(color: c.textPrimary),
            ),
          ),
        ],
      ),
      const SizedBox(height: AlySpacing.sm),
      Text(
        'عادةً أقل من دقيقة.',
        style: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
      ),
      const SizedBox(height: AlySpacing.xl),
      // Tertiary, deliberately. Cancelling is legitimate and must be reachable,
      // but it is not what the rider came to do, and a prominent cancel next to
      // a wait invites a tap that was never intended.
      AlyButton(
        label: 'إلغاء الطلب',
        onPressed: onCancel,
        variant: AlyButtonVariant.tertiary,
      ),
    ];
  }

  List<Widget> _onTrip(BuildContext context, AlyColors c) {
    final ride = state.ride;
    final driver = state.driver;

    return [
      if (ride != null) AlyTripStatusTimeline(status: ride.status),
      if (driver != null) ...[
        const SizedBox(height: AlySpacing.lg),
        AlyDriverCard(driver: driver),
      ],
      const SizedBox(height: AlySpacing.lg),
      if (ride != null)
        AlyRouteSummary(
          pickupAddress: ride.pickupAddress ?? 'نقطة الانطلاق',
          dropoffAddress: ride.dropoffAddress ?? 'الوجهة',
        ),
    ];
  }
}

/// A recent or saved destination.
class _RecentRow extends StatelessWidget {
  const _RecentRow({required this.place, required this.onTap});

  final SavedPlace place;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AlyRadius.sm),
      child: Padding(
        padding: const EdgeInsetsDirectional.symmetric(vertical: AlySpacing.md),
        child: Row(
          children: [
            Icon(
              place.isSaved ? Icons.star_rounded : Icons.history_rounded,
              size: 20,
              color: c.textTertiary,
            ),
            const SizedBox(width: AlySpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    place.label,
                    style: AlyTypography.body.copyWith(color: c.textPrimary),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    place.address,
                    style: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// An informational block that is not a failure.
///
/// Distinct from [AlyErrorState] on purpose: "you turned location off" is a
/// choice the rider made, and dressing it as an error tells them they did
/// something wrong.
class _Notice extends StatelessWidget {
  const _Notice({
    required this.icon,
    required this.title,
    required this.message,
    required this.actionLabel,
    required this.onAction,
  });

  final IconData icon;
  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Container(
      padding: const EdgeInsetsDirectional.all(AlySpacing.md),
      decoration: BoxDecoration(
        color: c.infoMuted,
        borderRadius: BorderRadius.circular(AlyRadius.md),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: c.info),
          const SizedBox(width: AlySpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(title, style: AlyTypography.label.copyWith(color: c.textPrimary)),
                const SizedBox(height: AlySpacing.xs),
                Text(
                  message,
                  style: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
                ),
                const SizedBox(height: AlySpacing.sm),
                AlyButton(
                  label: actionLabel,
                  onPressed: onAction,
                  variant: AlyButtonVariant.tertiary,
                  size: AlyButtonSize.medium,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
