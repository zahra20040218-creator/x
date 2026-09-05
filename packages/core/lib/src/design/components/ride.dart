import 'package:flutter/material.dart';
import 'package:rideapp_core/src/design/tokens/colors.dart';
import 'package:rideapp_core/src/design/tokens/metrics.dart';
import 'package:rideapp_core/src/design/tokens/typography.dart';
import 'package:rideapp_core/src/design/widgets.dart';
import 'package:rideapp_core/src/l10n/dates.dart';
import 'package:rideapp_core/src/l10n/strings.dart';
import 'package:rideapp_core/src/models/models.dart';

/// Ride and trip presentation.
///
/// ## Why these five live together
///
/// They are one idea seen at five distances: a ride in a list, the two points
/// that define it, its progress through the state machine, the person on the
/// other end of it, and the score the two parties give each other. Splitting
/// them across files is how the pickup/dropoff pair ends up drawn four
/// different ways in four screens — and that pair is the single most repeated
/// element in the product.
///
/// ## Strings
///
/// Everything that already exists in [AppStrings] is read from there, so the
/// same widget renders Arabic or English with no second code path.
/// [AppStrings.of] falls back to Arabic when no `Localizations` is installed,
/// which is the correct default for Baghdad — an unlocalised build shows
/// Arabic, not `RideStatus.driverArrived`.

/// The pickup/dropoff pair, with the connector between the two dots.
///
/// ## Why the rail is built as three rows rather than one stretched column
///
/// The obvious implementation puts the dots and the line in one column and
/// stretches it to the height of the addresses, which needs `IntrinsicHeight`
/// and re-measures the text twice. This one places the pickup dot, a
/// fixed-height connector, and the dropoff dot as three siblings, so the
/// geometry is known before layout and cannot change with the text. That
/// matters here more than anywhere else in the product: this widget appears in
/// every history row, on the offer sheet a driver has fifteen seconds to read,
/// and on the live trip card.
///
/// The dot is nudged down by the height of half a line of text, computed from
/// the live [TextScaler], so it stays optically centred on the first line of
/// the address at 1x and at 2x. A hard-coded 6pt offset looks correct in a
/// screenshot and floats above the text for anyone using large type.
///
/// ## Shape, not just colour
///
/// Pickup is a ring, dropoff is solid. They are also `mapPickup` green and
/// `mapDropoff` red, but colour alone would leave the pair indistinguishable
/// for a red/green colour-blind rider — who is roughly one man in twelve.
class AlyRouteSummary extends StatelessWidget {
  const AlyRouteSummary({
    required this.pickupAddress,
    required this.dropoffAddress,
    super.key,
    this.maxLines = 1,
    this.style,
  });

  /// The common case, so the two null-address fallbacks live in one place
  /// instead of at every call site.
  AlyRouteSummary.forRide(
    Ride ride, {
    super.key,
    this.maxLines = 1,
    this.style,
  })  : pickupAddress = ride.pickupAddress,
        dropoffAddress = ride.dropoffAddress;

  /// Same, for the offer a driver is deciding on.
  AlyRouteSummary.forOffer(
    RideOffer offer, {
    super.key,
    this.maxLines = 1,
    this.style,
  })  : pickupAddress = offer.pickupAddress,
        dropoffAddress = offer.dropoffAddress;

  /// Null when the rider dropped a pin instead of choosing a named place.
  final String? pickupAddress;
  final String? dropoffAddress;

  /// 1 in a list row, 2 on a detail screen. Anything longer ellipsizes; an
  /// address that wraps to four lines pushes the fare off a history row.
  final int maxLines;

  final TextStyle? style;

  static const double _railWidth = AlySpacing.lg;
  static const double _dotSize = AlySpacing.md;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final textStyle = (style ?? AlyTypography.body).copyWith(color: c.textPrimary);

    // Half a line of text, at whatever scale the user has chosen. `height` is a
    // multiple of font size in Flutter, so this is the real rendered leading.
    final lineHeight =
        MediaQuery.textScalerOf(context).scale(textStyle.fontSize ?? 15) *
            (textStyle.height ?? 1.4);
    final dotOffset = ((lineHeight - _dotSize) / 2).clamp(0.0, double.infinity);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _leg(
          context,
          dot: _dot(c.mapPickup, filled: false, surface: c.surface),
          dotOffset: dotOffset,
          // A pin with no reverse-geocoded name still has to say something.
          // Coordinates would be honest and useless — nobody recognises
          // 33.3152, 44.3661 as their own street.
          label: pickupAddress ?? _pinFallback,
          style: textStyle,
        ),
        SizedBox(
          height: AlySpacing.md,
          child: Row(
            children: [
              SizedBox(
                width: _railWidth,
                child: Center(
                  child: Container(width: 2, height: double.infinity, color: c.borderStrong),
                ),
              ),
            ],
          ),
        ),
        _leg(
          context,
          dot: _dot(c.mapDropoff, filled: true, surface: c.surface),
          dotOffset: dotOffset,
          label: dropoffAddress ?? _pinFallback,
          style: textStyle,
        ),
      ],
    );
  }

  /// Not in [AppStrings] yet; it belongs there the next time that file is
  /// touched. Hard-coded Arabic here rather than an English placeholder,
  /// because a placeholder is what ships.
  static const String _pinFallback = 'موقع محدد على الخريطة';

  Widget _leg(
    BuildContext context, {
    required Widget dot,
    required double dotOffset,
    required String label,
    required TextStyle style,
  }) =>
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: _railWidth,
            child: Padding(
              padding: EdgeInsetsDirectional.only(top: dotOffset),
              child: Center(child: dot),
            ),
          ),
          const SizedBox(width: AlySpacing.md),
          Expanded(
            child: Text(
              label,
              style: style,
              maxLines: maxLines,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      );

  Widget _dot(Color colour, {required bool filled, required Color surface}) => Container(
        width: _dotSize,
        height: _dotSize,
        decoration: BoxDecoration(
          color: filled ? colour : surface,
          shape: BoxShape.circle,
          border: Border.all(color: colour, width: 2.5),
        ),
      );
}

/// A ride's state, as a word rather than a colour.
///
/// The tone is a second channel, never the only one: the label always says what
/// happened. A green pill with no text is meaningless to a screen reader and
/// ambiguous to everyone else.
class AlyRideStatusBadge extends StatelessWidget {
  const AlyRideStatusBadge({required this.status, super.key});

  final RideStatus status;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final (foreground, background) = _tone(c);

    return Container(
      padding: const EdgeInsetsDirectional.symmetric(
        horizontal: AlySpacing.sm,
        vertical: AlySpacing.xs,
      ),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AlyRadius.sm),
      ),
      child: Text(
        AppStrings.of(context).statusLabel(status),
        style: AlyTypography.label.copyWith(color: foreground),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }

  /// Four tones, not eleven. `primary` means the ride is live and the user
  /// should be looking at it; `success` means money changed hands; `error`
  /// means someone cancelled; `warning` means the system gave up. A colour per
  /// state would carry no information at all.
  (Color, Color) _tone(AlyColors c) => switch (status) {
        RideStatus.requested || RideStatus.offered => (c.info, c.infoMuted),
        RideStatus.accepted ||
        RideStatus.driverArrived ||
        RideStatus.inProgress =>
          (c.primary, c.primaryMuted),
        RideStatus.completed => (c.success, c.successMuted),
        RideStatus.cancelledByRider ||
        RideStatus.cancelledByDriver ||
        RideStatus.cancelledInTrip =>
          (c.error, c.errorMuted),
        RideStatus.expired || RideStatus.noDriversFound => (c.warning, c.warningMuted),
      };
}

/// One ride in a history list.
///
/// ## The fare of an unfinished ride
///
/// `finalFareIqd` is null until the driver confirms collection, and a card that
/// rendered `ride.displayFareIqd` unconditionally would show the *estimate*
/// under no label at all — a number a rider would reasonably read as what they
/// were charged. So there are three cases, and each says which one it is:
///
///   - settled: the number, plainly;
///   - still running: the number under a "تقديري" label;
///   - cancelled with nothing settled: the words, no number.
///
/// Rendering `0 د.ع` for the third case would be the worst of the three — a
/// zero looks like a fact, and a rider who cancelled will read it as one.
class AlyRideCard extends StatelessWidget {
  const AlyRideCard({required this.ride, required this.onTap, super.key});

  final Ride ride;

  /// Null makes the card inert — no ripple, no button semantics. There is no
  /// separate `enabled` flag, for the reason `AlyButton` does not have one:
  /// two ways to disable one control eventually disagree.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final strings = AppStrings.of(context);

    // The moment the ride mattered to the user, in the order they would ask
    // about it: when it ended, when it died, when it started.
    final when = ride.completedAt ?? ride.cancelledAt ?? ride.requestedAt;

    return Semantics(
      button: onTap != null,
      container: true,
      child: Container(
        decoration: BoxDecoration(
          color: c.surface,
          borderRadius: BorderRadius.circular(AlyRadius.md),
          border: Border.all(color: c.border),
          // Dark mode carries elevation as luminance, not shadow — a shadow on
          // grey950 is invisible and only costs a raster layer.
          boxShadow: c.brightness == Brightness.dark ? AlyElevation.none : AlyElevation.low,
        ),
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(AlyRadius.md),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      // Both sides flexible, so at 2x type neither the date nor
                      // a long status ("أُلغيت أثناء الرحلة") can push the
                      // other off the card.
                      Flexible(
                        child: Text(
                          formatDateTimeAr(when, locale: strings.languageCode),
                          style: AlyTypography.caption.copyWith(color: c.textSecondary),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: AlySpacing.sm),
                      Flexible(child: AlyRideStatusBadge(status: ride.status)),
                    ],
                  ),
                  const SizedBox(height: AlySpacing.md),
                  AlyRouteSummary.forRide(ride),
                  Divider(height: AlySpacing.xl, color: c.border),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Flexible(
                        child: Text(
                          strings.fare,
                          style: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: AlySpacing.sm),
                      Flexible(child: _fare(context, c, strings)),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _fare(BuildContext context, AlyColors c, AppStrings strings) {
    final settled = ride.finalFareIqd;

    if (settled != null) {
      return FareText(
        settled,
        style: AlyTypography.numericSmall.copyWith(color: c.textPrimary),
      );
    }

    if (ride.status.isActive) {
      // Stacked rather than inline: the qualifier must not be able to push the
      // number out of the card at a large text scale, and a label above a
      // number reads as belonging to it.
      return Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            strings.estimated,
            style: AlyTypography.caption.copyWith(color: c.textTertiary),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          FareText(
            ride.estimatedFareIqd,
            style: AlyTypography.numericSmall.copyWith(color: c.textSecondary),
          ),
        ],
      );
    }

    // Terminal and never settled — cancelled, expired, nobody found. There is
    // no fare, and there will not be one.
    return Text(
      _noFare,
      style: AlyTypography.bodySmall.copyWith(color: c.textTertiary),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
  }

  static const String _noFare = 'بدون أجرة';
}

/// The ride's lifecycle as a vertical stepper.
///
/// ## Why cancellation is a step and not a gap
///
/// The naive stepper renders four fixed steps and greys out whatever did not
/// happen, so a ride the driver cancelled outside your building looks exactly
/// like a ride still in progress — the rider is left waiting on a timeline that
/// will never advance. Here a cancellation replaces the remaining steps with a
/// single red terminal step carrying the reason from [AppStrings.statusLabel].
/// The line stops there because the ride stopped there.
///
/// ## Why `IntrinsicHeight`
///
/// The connector has to run from one dot to the next whatever the label costs,
/// and a label's height is not knowable in advance once the user picks a text
/// scale. Four steps is a fixed, tiny budget for the second layout pass; the
/// alternative is a line that visibly breaks at 2x type, which is the kind of
/// defect that only ever shows on the phone of the person who needs large text.
class AlyTripStatusTimeline extends StatelessWidget {
  const AlyTripStatusTimeline({
    required this.status,
    super.key,
    this.acceptedAt,
    this.driverArrivedAt,
    this.startedAt,
    this.completedAt,
    this.cancelledAt,
  });

  AlyTripStatusTimeline.forRide(Ride ride, {super.key})
      : status = ride.status,
        acceptedAt = ride.acceptedAt,
        driverArrivedAt = ride.driverArrivedAt,
        startedAt = ride.startedAt,
        completedAt = ride.completedAt,
        cancelledAt = ride.cancelledAt;

  final RideStatus status;
  final DateTime? acceptedAt;
  final DateTime? driverArrivedAt;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final DateTime? cancelledAt;

  static const List<RideStatus> _steps = [
    RideStatus.accepted,
    RideStatus.driverArrived,
    RideStatus.inProgress,
    RideStatus.completed,
  ];

  static const double _railWidth = AlySpacing.xl;

  bool get _isTerminated => const {
        RideStatus.cancelledByRider,
        RideStatus.cancelledByDriver,
        RideStatus.cancelledInTrip,
        RideStatus.expired,
        RideStatus.noDriversFound,
      }.contains(status);

  /// The last step the ride actually reached.
  ///
  /// For a cancellation the status alone does not say how far it got, so the
  /// timestamps decide. `CANCELLED_IN_TRIP` is the exception: the state machine
  /// only permits it from `IN_PROGRESS`, so the answer is known without them.
  int get _reached => switch (status) {
        RideStatus.accepted => 0,
        RideStatus.driverArrived => 1,
        RideStatus.inProgress => 2,
        RideStatus.completed => 3,
        RideStatus.cancelledInTrip => 2,
        RideStatus.cancelledByRider || RideStatus.cancelledByDriver => _fromTimestamps,
        RideStatus.requested ||
        RideStatus.offered ||
        RideStatus.expired ||
        RideStatus.noDriversFound =>
          -1,
      };

  int get _fromTimestamps {
    if (startedAt != null) return 2;
    if (driverArrivedAt != null) return 1;
    if (acceptedAt != null) return 0;
    return -1;
  }

  DateTime? _timeFor(int index) => switch (index) {
        0 => acceptedAt,
        1 => driverArrivedAt,
        2 => startedAt,
        _ => completedAt,
      };

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final strings = AppStrings.of(context);
    final reached = _reached;

    // Green once the money is settled, brand teal while it is still moving.
    final accent = status == RideStatus.completed ? c.success : c.primary;
    final onAccent = status == RideStatus.completed ? c.onSuccess : c.onPrimary;

    // A terminated ride shows the steps it actually reached and then stops. A
    // live one shows all four, so the rider can see what is still ahead.
    final reachedSteps = _isTerminated ? reached + 1 : _steps.length;

    final rows = <Widget>[
      for (var i = 0; i < reachedSteps; i++)
        _StepRow(
          label: strings.statusLabel(_steps[i]),
          time: _timeFor(i),
          tone: _isTerminated
              ? _StepTone.done
              : (i < reached
                  ? _StepTone.done
                  : (i == reached ? _StepTone.current : _StepTone.future)),
          accent: accent,
          onAccent: onAccent,
          isLast: !_isTerminated && i == _steps.length - 1,
          railWidth: _railWidth,
        ),
      if (_isTerminated)
        _StepRow(
          label: strings.statusLabel(status),
          time: cancelledAt,
          tone: _StepTone.terminated,
          accent: c.error,
          onAccent: c.onError,
          isLast: true,
          railWidth: _railWidth,
        ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: rows,
    );
  }
}

enum _StepTone { done, current, future, terminated }

class _StepRow extends StatelessWidget {
  const _StepRow({
    required this.label,
    required this.time,
    required this.tone,
    required this.accent,
    required this.onAccent,
    required this.isLast,
    required this.railWidth,
  });

  final String label;
  final DateTime? time;
  final _StepTone tone;
  final Color accent;
  final Color onAccent;
  final bool isLast;
  final double railWidth;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    final (fill, border, icon, labelColour, labelStyle) = switch (tone) {
      _StepTone.done => (accent, accent, Icons.check_rounded, c.textSecondary, AlyTypography.body),
      _StepTone.current => (accent, accent, Icons.circle, c.textPrimary, AlyTypography.title),
      _StepTone.future => (c.surface, c.borderStrong, null, c.textTertiary, AlyTypography.body),
      _StepTone.terminated => (c.error, c.error, Icons.close_rounded, c.error, AlyTypography.title),
    };

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: railWidth,
            child: Column(
              children: [
                Container(
                  width: railWidth,
                  height: railWidth,
                  decoration: BoxDecoration(
                    color: fill,
                    shape: BoxShape.circle,
                    border: Border.all(color: border, width: 2),
                  ),
                  child: icon == null
                      ? null
                      : Icon(icon, size: tone == _StepTone.current ? 10 : 14, color: onAccent),
                ),
                if (!isLast)
                  // A bare `Expanded` rather than a stretched box: its intrinsic
                  // height is zero, so `IntrinsicHeight` above measures the
                  // label and not an infinity.
                  Expanded(child: Container(width: 2, color: c.borderStrong)),
              ],
            ),
          ),
          const SizedBox(width: AlySpacing.md),
          Expanded(
            child: Padding(
              padding: EdgeInsetsDirectional.only(bottom: isLast ? 0 : AlySpacing.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(label, style: labelStyle.copyWith(color: labelColour)),
                  if (time != null)
                    Text(
                      _hhmm(time!),
                      style: AlyTypography.caption.copyWith(color: c.textTertiary),
                      textDirection: TextDirection.ltr,
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Local wall-clock time, formatted without `intl` locale data.
  ///
  /// `DateFormat` needs `initializeDateFormatting` for any locale but `en_US`,
  /// and a design-system component that throws because the host app skipped a
  /// bootstrap call is a trap. `HH:mm` in Western digits is what
  /// `formatDateTimeAr` produces anyway, and CLAUDE.md §8 already fixes the
  /// digit choice.
  static String _hhmm(DateTime value) {
    final local = value.toLocal();
    return '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
  }
}

/// Who is collecting you.
///
/// ## The missing field
///
/// There is no phone number here and no parameter that could carry one.
/// [PublicUser] does not have the field, and this widget does not reintroduce
/// it via a `subtitle` or a `trailing` slot — either would be an invitation to
/// pass one. Contact between rider and driver is a v2 decision about masked
/// numbers, not something a card should quietly enable.
///
/// The plate gets its own bordered chip in tabular figures, at the END of the
/// row. It is the one thing on this card a rider reads character by character,
/// standing on a kerb, comparing it against a car; it should not be a fragment
/// of a sentence.
class AlyDriverCard extends StatelessWidget {
  const AlyDriverCard({required this.driver, super.key});

  final PublicUser driver;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final vehicle = driver.vehicle;
    final rating = driver.rating;

    final descriptors = <String>[
      if (vehicle != null && vehicle.model.isNotEmpty) vehicle.model,
      if (vehicle != null && vehicle.color.isNotEmpty) vehicle.color,
    ];

    return MergeSemantics(
      child: Container(
        padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
        decoration: BoxDecoration(
          color: c.surface,
          borderRadius: BorderRadius.circular(AlyRadius.md),
          border: Border.all(color: c.border),
          boxShadow: c.brightness == Brightness.dark ? AlyElevation.none : AlyElevation.low,
        ),
        // The plate moves to its own line when it cannot fit beside the name.
        //
        // It was a fixed trailing child of the Row, and at a 1.8x system text
        // scale on a 360pt phone that overflowed by 66 pixels. The obvious
        // fixes are both wrong for this particular value:
        //
        //   - `Flexible` + ellipsis would truncate it. A plate is how a rider
        //     identifies the car pulling up. Half a plate is not a plate.
        //   - Capping its textScaler would ignore the accessibility setting on
        //     the one string a partially-sighted rider most needs to read.
        //
        // So the LAYOUT gives way instead of the content. Measured against the
        // real available width rather than a breakpoint guess, because the
        // trigger is text scale times plate length, not screen size.
        child: LayoutBuilder(
          builder: (context, constraints) {
            final plate = vehicle != null && vehicle.plate.isNotEmpty
                ? _Plate(plate: vehicle.plate)
                : null;

            final scale = MediaQuery.textScalerOf(context).scale(15) / 15;
            // Avatar + gutters + a conservative estimate of the plate's width.
            final plateWidth = plate == null
                ? 0.0
                : (vehicle!.plate.length * 9 * scale) + (AlySpacing.sm * 2) + AlySpacing.md;
            final fitsBeside =
                plate == null || constraints.maxWidth - plateWidth > 140 * scale;

            final identity = Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  driver.displayName,
                  style: AlyTypography.title.copyWith(color: c.textPrimary),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (rating != null) ...[
                  const SizedBox(height: AlySpacing.xs),
                  AlyRatingStars(value: rating),
                ],
                if (descriptors.isNotEmpty) ...[
                  const SizedBox(height: AlySpacing.xs),
                  Text(
                    descriptors.join(' · '),
                    style: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            );

            final header = Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Avatar(name: driver.displayName),
                const SizedBox(width: AlySpacing.md),
                Expanded(child: identity),
                if (plate != null && fitsBeside) ...[
                  const SizedBox(width: AlySpacing.md),
                  plate,
                ],
              ],
            );

            if (plate == null || fitsBeside) return header;

            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                header,
                const SizedBox(height: AlySpacing.md),
                // Aligned to the START edge so it mirrors with the name above
                // it rather than drifting to the opposite side in English.
                Align(alignment: AlignmentDirectional.centerStart, child: plate),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final trimmed = name.trim();
    // `characters`, not `name[0]`: an Arabic name is fine either way, but an
    // emoji or a combining mark in a display name would be split mid-rune and
    // render as a replacement box.
    final initial = trimmed.characters.isEmpty ? '؟' : trimmed.characters.first;

    return ExcludeSemantics(
      child: Container(
        width: AlySpacing.tapTargetSmall,
        height: AlySpacing.tapTargetSmall,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: c.primaryMuted, shape: BoxShape.circle),
        child: Text(initial, style: AlyTypography.h3.copyWith(color: c.primary)),
      ),
    );
  }
}

class _Plate extends StatelessWidget {
  const _Plate({required this.plate});

  final String plate;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Container(
      padding: const EdgeInsetsDirectional.symmetric(
        horizontal: AlySpacing.sm,
        vertical: AlySpacing.xs,
      ),
      decoration: BoxDecoration(
        color: c.surfaceSunken,
        borderRadius: BorderRadius.circular(AlyRadius.sm),
        border: Border.all(color: c.borderStrong),
      ),
      child: Text(
        plate,
        style: AlyTypography.numericSmall.copyWith(color: c.textPrimary),
        // A plate is a code, not prose. Left-to-right in both languages, or the
        // digit groups reorder and the rider compares the wrong number.
        textDirection: TextDirection.ltr,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

/// A rating, read or given.
///
/// ## Two modes, one widget
///
/// The default constructor displays a score — five stars plus the number,
/// because "4.6" is precise where four-and-a-bit stars is an estimate the eye
/// has to make. [AlyRatingStars.input] collects one, and is the only mode with
/// touch targets.
///
/// The input stars are [AlySpacing.tapTargetSmall] each. A 20pt star is a 20pt
/// star; the target around it is 48, because the difference between "4" and "5"
/// being a missed tap is a driver losing a point they earned. The glyph size
/// does not follow the text scale — five scaled targets would run off a narrow
/// phone — and each star carries its own semantic label so a screen-reader user
/// can pick a value rather than hunting five identical buttons.
class AlyRatingStars extends StatelessWidget {
  const AlyRatingStars({
    required this.value,
    super.key,
    this.showValue = true,
    this.starSize = 16,
  })  : onChanged = null,
        isInteractive = false;

  const AlyRatingStars.input({
    required this.value,
    required this.onChanged,
    super.key,
  })  : showValue = false,
        starSize = 28,
        isInteractive = true;

  /// 0–5. Displayed to one decimal beside the stars.
  final double value;

  final bool showValue;

  /// Null disables the input: the stars mute and no tap is delivered.
  final ValueChanged<int>? onChanged;

  final bool isInteractive;
  final double starSize;

  static const int _max = 5;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    return isInteractive ? _buildInput(context, c) : _buildDisplay(context, c);
  }

  Widget _buildDisplay(BuildContext context, AlyColors c) {
    final clamped = value.clamp(0.0, _max.toDouble());

    return Semantics(
      label: 'التقييم ${clamped.toStringAsFixed(1)} من $_max',
      child: ExcludeSemantics(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var star = 1; star <= _max; star++)
              Icon(
                _glyph(clamped, star),
                size: starSize,
                color: clamped >= star - 0.5 ? c.accent : c.borderStrong,
              ),
            if (showValue) ...[
              const SizedBox(width: AlySpacing.xs),
              Text(
                clamped.toStringAsFixed(1),
                style: AlyTypography.numericSmall.copyWith(color: c.textSecondary),
                textDirection: TextDirection.ltr,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildInput(BuildContext context, AlyColors c) {
    final enabled = onChanged != null;
    final selected = value.round().clamp(0, _max);

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var star = 1; star <= _max; star++)
          Semantics(
            button: true,
            enabled: enabled,
            selected: star <= selected,
            label: _label(star),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: enabled ? () => onChanged!(star) : null,
              child: SizedBox(
                width: AlySpacing.tapTargetSmall,
                height: AlySpacing.tapTargetSmall,
                child: Icon(
                  star <= selected ? Icons.star_rounded : Icons.star_outline_rounded,
                  size: starSize,
                  color: !enabled
                      ? c.textDisabled
                      : (star <= selected ? c.accent : c.borderStrong),
                ),
              ),
            ),
          ),
      ],
    );
  }

  IconData _glyph(double score, int star) {
    if (score >= star) return Icons.star_rounded;
    if (score >= star - 0.5) return Icons.star_half_rounded;
    return Icons.star_outline_rounded;
  }

  /// Arabic counts in three forms and a screen reader will say exactly what it
  /// is given, so "1 نجوم" is not an option.
  static String _label(int star) => switch (star) {
        1 => 'نجمة واحدة',
        2 => 'نجمتان',
        _ => '$star نجوم',
      };
}
