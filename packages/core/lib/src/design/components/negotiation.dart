import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:rideapp_core/src/design/components/buttons.dart';
import 'package:rideapp_core/src/design/components/states.dart';
import 'package:rideapp_core/src/design/tokens/colors.dart';
import 'package:rideapp_core/src/design/tokens/metrics.dart';
import 'package:rideapp_core/src/design/tokens/typography.dart';
import 'package:rideapp_core/src/design/widgets.dart';
import 'package:rideapp_core/src/models/models.dart';
import 'package:rideapp_core/src/money/iqd.dart';

/// Fare negotiation — the one interaction ALY has that its competitors do not.
///
/// ## Why this is not a form
///
/// A form asks for a value and validates it. A marketplace tells you where you
/// stand: whether the number you just typed is one drivers actually take, how
/// the offer in front of you compares to what you asked for, and how long you
/// have to decide. Every widget in this file is built around one of those three
/// questions, because a rider who cannot answer them will simply type the first
/// number they think of and then wait, confused, while nobody replies.
///
/// ## The two clocks
///
/// The rider is browsing; the driver is deciding. The rider's side ([AlyOfferList])
/// is allowed to be calm and can afford a list that grows. The driver's side
/// ([AlyCounterOfferSheet]) is a three-second decision taken one-handed in a
/// moving car against a server deadline, so it carries exactly one prominent
/// action and everything else is deliberately quieter.
///
/// ## Money
///
/// Every amount here is `int` IQD (CLAUDE.md §6.1) and is rendered through
/// [FareText] or [IqdFormatter], never formatted ad hoc. A `double` cannot
/// reach this file, which is the point.

/// The fare-rounding grid. Baghdad prices move in 250-dinar steps; a stepper
/// that moved in 100s would produce fares no one quotes out loud.
const int _defaultStepIqd = 250;

/// The rider's price input.
///
/// ## Controlled, not self-owning
///
/// The value lives with the caller. A negotiation screen has to send this
/// number to the server, compare incoming offers against it and restore it
/// after a reconnect, and a widget that quietly owned the truth would let the
/// screen and the field disagree — which on this screen means the rider sees
/// one price and the drivers were sent another.
///
/// ## Typing and stepping are both first class
///
/// Steppers alone make a rider walk 2,000 dinars in eight taps. A bare text
/// field alone makes them think from scratch. So the figure is an editable
/// field the whole time — no tap-to-edit mode, because a mode you have to
/// discover is a mode most people never find — and the steppers nudge it along
/// a round grid: a typed 8,123 steps up to 8,250, not to 8,373.
///
/// ## Why the value is not clamped while typing
///
/// Clamping on every keystroke eats digits: a minimum of 5,000 turns the "8" of
/// "8,000" into "5,000" before the rider has typed the second character.
/// Out-of-range values are therefore allowed to exist mid-edit and are clamped
/// when the field loses focus or the keyboard's done key is pressed.
class AlyFareProposal extends StatefulWidget {
  const AlyFareProposal({
    required this.valueIqd,
    required this.onChanged,
    required this.suggestedIqd,
    required this.minIqd,
    required this.maxIqd,
    super.key,
    this.stepIqd = _defaultStepIqd,
    this.enabled = true,
    this.showGuidance = true,
    this.title = 'السعر الذي تعرضه',
    this.rangeLabel = 'النطاق المعتاد لهذه الرحلة',
  })  : assert(minIqd <= maxIqd, 'minIqd must not exceed maxIqd'),
        assert(stepIqd > 0, 'stepIqd must be positive');

  /// The current proposal, in whole IQD.
  final int valueIqd;

  final ValueChanged<int> onChanged;

  /// Where this trip usually settles. Drives the guidance line and the tick on
  /// the range track — it is a market fact, not a default value.
  final int suggestedIqd;

  final int minIqd;
  final int maxIqd;

  final int stepIqd;

  /// False while the request is in flight, so the rider cannot move the price
  /// out from under an offer that is already being sent.
  final bool enabled;

  /// The "you are below/above the usual price" line. Off inside
  /// [AlyCounterOfferSheet], where the same sentence would be advice for the
  /// wrong side of the trade.
  final bool showGuidance;

  final String title;
  final String rangeLabel;

  @override
  State<AlyFareProposal> createState() => _AlyFareProposalState();
}

class _AlyFareProposalState extends State<AlyFareProposal> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    _controller.text = IqdFormatter.formatBare(widget.valueIqd);
    _focus.addListener(_onFocusChanged);
  }

  @override
  void didUpdateWidget(AlyFareProposal oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only when the caller moved the value somewhere the field is not already
    // showing. Rewriting the text on every rebuild would fight the caret.
    if (widget.valueIqd != oldWidget.valueIqd &&
        widget.valueIqd != _parse(_controller.text)) {
      _write(widget.valueIqd);
    }
  }

  @override
  void dispose() {
    _focus
      ..removeListener(_onFocusChanged)
      ..dispose();
    _controller.dispose();
    super.dispose();
  }

  static int? _parse(String text) {
    final digits = text.replaceAll(RegExp('[^0-9]'), '');
    return digits.isEmpty ? null : int.tryParse(digits);
  }

  void _write(int value) {
    final text = IqdFormatter.formatBare(value);
    if (_controller.text == text) return;
    _controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  void _onFocusChanged() {
    if (!_focus.hasFocus) _commit();
  }

  /// Range enforcement happens here rather than per keystroke — see the class
  /// doc. An empty field falls back to the caller's value instead of zero,
  /// because a cleared field means "I am retyping", not "free ride".
  void _commit() {
    final typed = _parse(_controller.text) ?? widget.valueIqd;
    final next = typed.clamp(widget.minIqd, widget.maxIqd);
    _write(next);
    if (next != widget.valueIqd) widget.onChanged(next);
  }

  void _onTextChanged(String raw) {
    final typed = _parse(raw);
    if (typed == null || typed == widget.valueIqd) return;
    widget.onChanged(typed);
  }

  /// Steps onto the round grid rather than by a raw addition, so a value that
  /// arrived by typing does not produce 8,373 on the next tap.
  void _nudge(int direction) {
    final step = widget.stepIqd;
    final value = widget.valueIqd;
    final raw = value % step == 0
        ? value + direction * step
        : (direction > 0 ? (value ~/ step + 1) * step : (value ~/ step) * step);
    final next = raw.clamp(widget.minIqd, widget.maxIqd);
    if (next == value) return;

    // The stepper is used without looking, at arm's length, on a phone in a
    // holder. The tick is how the rider knows the tap registered.
    unawaited(HapticFeedback.selectionClick());
    _write(next);
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final canDecrease = widget.enabled && widget.valueIqd > widget.minIqd;
    final canIncrease = widget.enabled && widget.valueIqd < widget.maxIqd;

    return Container(
      padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(AlyRadius.lg),
        border: Border.all(color: c.border),
        boxShadow: AlyElevation.low,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            widget.title,
            style: AlyTypography.label.copyWith(color: c.textSecondary),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: AlySpacing.md),
          Row(
            children: [
              AlyIconButton(
                icon: Icons.remove_rounded,
                semanticLabel: 'إنقاص السعر',
                onPressed: canDecrease ? () => _nudge(-1) : null,
                filled: true,
              ),
              Expanded(child: _figure(context, c)),
              AlyIconButton(
                icon: Icons.add_rounded,
                semanticLabel: 'زيادة السعر',
                onPressed: canIncrease ? () => _nudge(1) : null,
                filled: true,
              ),
            ],
          ),
          const SizedBox(height: AlySpacing.lg),
          _RangeTrack(
            valueIqd: widget.valueIqd,
            suggestedIqd: widget.suggestedIqd,
            minIqd: widget.minIqd,
            maxIqd: widget.maxIqd,
          ),
          const SizedBox(height: AlySpacing.sm),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              FareText(
                widget.minIqd,
                style: AlyTypography.caption.copyWith(color: c.textTertiary),
              ),
              FareText(
                widget.maxIqd,
                style: AlyTypography.caption.copyWith(color: c.textTertiary),
              ),
            ],
          ),
          const SizedBox(height: AlySpacing.xs),
          Text(
            widget.rangeLabel,
            style: AlyTypography.caption.copyWith(color: c.textTertiary),
            textAlign: TextAlign.center,
          ),
          if (widget.showGuidance) ...[
            const SizedBox(height: AlySpacing.md),
            _Guidance(valueIqd: widget.valueIqd, suggestedIqd: widget.suggestedIqd),
          ],
        ],
      ),
    );
  }

  Widget _figure(BuildContext context, AlyColors c) {
    final fontSize = AlyTypography.display.fontSize ?? 34;
    final scaled = MediaQuery.textScalerOf(context).scale(fontSize);

    // Room for "999,999" in a tabular face, measured from the SCALED size: a
    // rider at 200% system text gets a wider well rather than a clipped fare.
    // The FittedBox above shrinks the whole group if the card is narrower than
    // that, which is the one case where scaling down beats truncating a price.
    final wellWidth = scaled * 0.62 * 7;

    return FittedBox(
      fit: BoxFit.scaleDown,
      child: Directionality(
        // A fare is a number, and [FareText] already renders money
        // left-to-right so the currency mark follows the digits. The editable
        // view has to make the same call, or the same fare would sit
        // differently in the field and in the offer card next to it.
        textDirection: TextDirection.ltr,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: wellWidth,
              child: TextField(
                controller: _controller,
                focusNode: _focus,
                enabled: widget.enabled,
                keyboardType: TextInputType.number,
                textInputAction: TextInputAction.done,
                textAlign: TextAlign.end,
                cursorColor: c.primary,
                style: AlyTypography.display.copyWith(
                  color: widget.enabled ? c.textPrimary : c.textDisabled,
                ),
                inputFormatters: const [_GroupedIqdFormatter()],
                decoration: const InputDecoration(
                  isDense: true,
                  filled: false,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  contentPadding: EdgeInsets.zero,
                ),
                onChanged: _onTextChanged,
                onSubmitted: (_) => _commit(),
              ),
            ),
            const SizedBox(width: AlySpacing.sm),
            Text(
              'د.ع',
              style: AlyTypography.h3.copyWith(color: c.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}

/// Keeps the thousands separators live while the rider types.
///
/// The caret is collapsed to the end on every edit. That is a real compromise —
/// it makes mid-string editing impossible — and it is taken because inserting a
/// separator shifts every offset after it, and the alternative (tracking the
/// caret through regrouping) is a well-known source of off-by-one jumps on a
/// field whose whole job is to be trusted at a glance. A fare is short enough
/// to retype.
class _GroupedIqdFormatter extends TextInputFormatter {
  const _GroupedIqdFormatter();

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final digits = newValue.text.replaceAll(RegExp('[^0-9]'), '');
    if (digits.isEmpty) return TextEditingValue.empty;
    // Nine digits is a billion dinars. Past that the parse is the risk, not the
    // layout, so the edit is simply refused.
    if (digits.length > 9) return oldValue;

    final value = int.tryParse(digits);
    if (value == null) return oldValue;

    final text = IqdFormatter.formatBare(value);
    return TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }
}

/// Where this proposal sits inside the band drivers actually accept.
///
/// The rail is the answer to "am I low or high", given in the one form a person
/// can read without arithmetic. The tick is the market's usual price, so the
/// rider sees the gap rather than being told about it.
class _RangeTrack extends StatelessWidget {
  const _RangeTrack({
    required this.valueIqd,
    required this.suggestedIqd,
    required this.minIqd,
    required this.maxIqd,
  });

  final int valueIqd;
  final int suggestedIqd;
  final int minIqd;
  final int maxIqd;

  double _fraction(int amount) {
    final span = maxIqd - minIqd;
    if (span <= 0) return 0.5;
    return ((amount - minIqd) / span).clamp(0.0, 1.0);
  }

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    // The numbers either side of the track already say all of this out loud, so
    // the rail itself is not read a second time by a screen reader.
    return ExcludeSemantics(
      child: SizedBox(
        height: AlySpacing.md,
        child: Stack(
          alignment: AlignmentDirectional.center,
          children: [
            Container(
              height: AlySpacing.xs,
              decoration: BoxDecoration(
                color: c.border,
                borderRadius: BorderRadius.circular(AlyRadius.pill),
              ),
            ),
            // Fills from the START edge, so it grows right-to-left in Arabic
            // and left-to-right in English with no second code path.
            FractionallySizedBox(
              alignment: AlignmentDirectional.centerStart,
              widthFactor: _fraction(valueIqd),
              child: Container(
                height: AlySpacing.xs,
                decoration: BoxDecoration(
                  color: c.primary,
                  borderRadius: BorderRadius.circular(AlyRadius.pill),
                ),
              ),
            ),
            Align(
              alignment: AlignmentDirectional(
                _fraction(suggestedIqd) * 2 - 1,
                0,
              ),
              child: Container(
                width: 2,
                height: AlySpacing.md,
                decoration: BoxDecoration(
                  color: c.textTertiary,
                  borderRadius: BorderRadius.circular(AlyRadius.pill),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One sentence telling the rider what their number will probably cost them.
///
/// Tone carries the meaning before the words are read: warning for "you will
/// wait", success for "this gets picked up". It is a live region because the
/// sentence changes under a stepper the user is holding, and a screen-reader
/// user who is stepping deserves the same feedback as one who is looking.
class _Guidance extends StatelessWidget {
  const _Guidance({required this.valueIqd, required this.suggestedIqd});

  final int valueIqd;
  final int suggestedIqd;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    final (IconData icon, Color tone, String message) = switch (valueIqd) {
      _ when valueIqd < suggestedIqd => (
        Icons.trending_down_rounded,
        c.warning,
        'أقل من المعتاد — قد يتأخر وصول العروض',
      ),
      _ when valueIqd == suggestedIqd => (
        Icons.check_circle_outline_rounded,
        c.success,
        'هذا هو السعر المعتاد لهذه الرحلة',
      ),
      _ => (
        Icons.bolt_rounded,
        c.success,
        'أعلى من المعتاد — عادةً يصل الرد بسرعة',
      ),
    };

    return Semantics(
      liveRegion: true,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: tone),
          const SizedBox(width: AlySpacing.xs),
          Expanded(
            child: Text(
              message,
              style: AlyTypography.bodySmall.copyWith(color: tone),
            ),
          ),
        ],
      ),
    );
  }
}

/// One driver's bid on a ride, as the rider sees it.
///
/// A presentation type rather than a wire model: `RideOffer` in `models.dart`
/// is the offer the SERVER makes to a driver, which is a different direction
/// and a different shape. Keeping this here means the negotiation UI can be
/// built and tested before the contract for the rider-facing feed is settled,
/// without inventing a model in the wire layer that the server does not send.
@immutable
class AlyDriverOffer {
  const AlyDriverOffer({
    required this.offerId,
    required this.driver,
    required this.fareIqd,
    required this.etaToPickup,
  });

  /// Stable identity. It is the list's key, so it must survive a refresh of the
  /// same offer — see [AlyOfferList]'s ordering rules.
  final String offerId;

  final PublicUser driver;

  /// What this driver wants for the trip, in whole IQD.
  final int fareIqd;

  /// How long until this driver reaches the pickup.
  final Duration etaToPickup;
}

/// One offer, laid out so the comparison is the fare and the wait.
///
/// ## The delta is relative to the rider's own number
///
/// Not to the estimate, not to the other offers. The rider typed a price and is
/// now asking one question about every card: "is this more or less than what I
/// said?" Showing the difference against anything else answers a question they
/// are not asking, and the mental subtraction they would otherwise do — under
/// time pressure, in a car — is exactly the work this card exists to remove.
///
/// A cheaper offer is a good outcome, so it takes the success tone. A dearer
/// one is a warning, not an error: nothing is broken, the rider may well take
/// it to be picked up sooner.
class AlyDriverOfferCard extends StatelessWidget {
  const AlyDriverOfferCard({
    required this.offer,
    required this.riderProposalIqd,
    required this.onAccept,
    super.key,
    this.isAccepting = false,
    this.acceptLabel = 'قبول',
  });

  final AlyDriverOffer offer;

  /// The rider's current proposal, which the delta is measured against.
  final int riderProposalIqd;

  /// Null while another offer is being claimed — two accepts in flight is how a
  /// rider ends up in an argument about which driver they agreed with.
  final VoidCallback? onAccept;

  final bool isAccepting;
  final String acceptLabel;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final driver = offer.driver;
    final vehicle = driver.vehicle;
    final minutes = (offer.etaToPickup.inSeconds / 60).round();

    return Container(
      padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(AlyRadius.md),
        border: Border.all(color: c.border),
        boxShadow: AlyElevation.low,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _DriverAvatar(name: driver.displayName),
              const SizedBox(width: AlySpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      driver.displayName,
                      style: AlyTypography.bodyLarge.copyWith(
                        color: c.textPrimary,
                        fontWeight: FontWeight.w600,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (driver.rating != null) ...[
                      const SizedBox(height: AlySpacing.xs),
                      _Rating(rating: driver.rating!),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: AlySpacing.md),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  FareText(
                    offer.fareIqd,
                    style: AlyTypography.numeric.copyWith(color: c.textPrimary),
                  ),
                  const SizedBox(height: AlySpacing.xs),
                  _FareDelta(
                    fareIqd: offer.fareIqd,
                    riderProposalIqd: riderProposalIqd,
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: AlySpacing.md),
          Wrap(
            spacing: AlySpacing.md,
            runSpacing: AlySpacing.sm,
            children: [
              _MetaItem(
                icon: Icons.schedule_rounded,
                text: minutes <= 0
                    ? 'يصل الآن'
                    : 'يصل خلال ${_arabicMinutes(minutes)}',
              ),
              if (vehicle != null)
                _MetaItem(
                  icon: Icons.directions_car_filled_rounded,
                  text: '${vehicle.model} · ${vehicle.color} · ${vehicle.plate}',
                ),
            ],
          ),
          const SizedBox(height: AlySpacing.lg),
          AlyButton(
            label: acceptLabel,
            onPressed: onAccept,
            size: AlyButtonSize.medium,
            isLoading: isAccepting,
            // The visible label is one word, so the fare and the driver go into
            // the announcement — otherwise a screen-reader user hears "قبول"
            // four times with nothing to tell the offers apart.
            semanticLabel:
                'قبول عرض ${driver.displayName} بمبلغ ${IqdFormatter.format(offer.fareIqd)}',
          ),
        ],
      ),
    );
  }
}

/// The difference between this offer and what the rider asked for.
class _FareDelta extends StatelessWidget {
  const _FareDelta({required this.fareIqd, required this.riderProposalIqd});

  final int fareIqd;
  final int riderProposalIqd;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final delta = fareIqd - riderProposalIqd;

    if (delta == 0) {
      return _Pill(
        background: c.surfaceSunken,
        foreground: c.textSecondary,
        icon: Icons.check_rounded,
        child: Text(
          'بسعرك تماماً',
          style: AlyTypography.label.copyWith(color: c.textSecondary),
        ),
      );
    }

    final cheaper = delta < 0;
    final tone = cheaper ? c.success : c.warning;

    return _Pill(
      background: cheaper ? c.successMuted : c.warningMuted,
      foreground: tone,
      icon: cheaper ? Icons.arrow_downward_rounded : Icons.arrow_upward_rounded,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            cheaper ? 'أقل بـ' : 'أعلى بـ',
            style: AlyTypography.label.copyWith(color: tone),
          ),
          const SizedBox(width: AlySpacing.xs),
          FareText(
            delta.abs(),
            style: AlyTypography.numericSmall.copyWith(color: tone),
          ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({
    required this.background,
    required this.foreground,
    required this.icon,
    required this.child,
  });

  final Color background;
  final Color foreground;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsetsDirectional.symmetric(
          horizontal: AlySpacing.sm,
          vertical: AlySpacing.xs,
        ),
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(AlyRadius.sm),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: foreground),
            const SizedBox(width: AlySpacing.xs),
            Flexible(child: child),
          ],
        ),
      );
}

/// The driver's initial in a circle.
///
/// 44pt because that is [AlySkeleton.circle]'s default: the loading state and
/// the loaded state are then the same shape, and the list does not visibly
/// re-lay-out when the offers land.
class _DriverAvatar extends StatelessWidget {
  const _DriverAvatar({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final trimmed = name.trim();
    final initial = trimmed.isEmpty ? '؟' : trimmed.characters.first;

    return ExcludeSemantics(
      child: Container(
        width: 44,
        height: 44,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: c.primaryMuted, shape: BoxShape.circle),
        child: Text(initial, style: AlyTypography.title.copyWith(color: c.primary)),
      ),
    );
  }
}

class _Rating extends StatelessWidget {
  const _Rating({required this.rating});

  final double rating;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Semantics(
      label: 'التقييم ${rating.toStringAsFixed(1)} من 5',
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.star_rounded, size: 16, color: c.accent),
          const SizedBox(width: AlySpacing.xs),
          Text(
            rating.toStringAsFixed(1),
            style: AlyTypography.numericSmall.copyWith(color: c.textSecondary),
            textDirection: TextDirection.ltr,
          ),
        ],
      ),
    );
  }
}

class _MetaItem extends StatelessWidget {
  const _MetaItem({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: c.textTertiary),
        const SizedBox(width: AlySpacing.xs),
        // Flexible, not bare: inside a Wrap a long vehicle line would otherwise
        // overflow its run at a large text scale instead of ellipsising.
        Flexible(
          child: Text(
            text,
            style: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

/// The rider's incoming offers.
///
/// ## Ordering: offers never move under a thumb
///
/// This is the defect the widget exists to prevent. Offers arrive over a socket
/// while the rider is reaching for one, and a list that re-sorts on arrival
/// moves the card out from under a finger that is already descending — so the
/// rider accepts a driver they did not choose, at a price they did not read.
/// It is unrecoverable: the claim is atomic on the server (CLAUDE.md §5.1), so
/// there is no undo.
///
/// The policy, in order:
///
///   1. The caller's sort is authoritative and is adopted as-is whenever the
///      list is idle — nothing is frozen for the sake of being frozen.
///   2. While a finger is DOWN anywhere on the list, and for [reorderGrace]
///      after it lifts, the visible order is pinned: rows that are still in the
///      caller's list keep their exact index, rows that vanished are dropped,
///      and genuinely new offers are APPENDED to the end. Never spliced in
///      above the thumb.
///   3. When the grace period ends, the caller's sort is adopted in one step.
///
/// The grace window exists because a pointer that has lifted is often mid-tap
/// on a scrolled list, and because we cannot see a thumb that is still in the
/// air. Two seconds is long enough to cover a scroll-then-tap and short enough
/// that a rider watching a quiet list still sees the cheapest offer rise.
///
/// Row identity is `offerId`, so a re-priced offer refreshes in place rather
/// than being torn down and rebuilt somewhere else.
class AlyOfferList extends StatefulWidget {
  const AlyOfferList({
    required this.offers,
    required this.riderProposalIqd,
    required this.onAccept,
    super.key,
    this.isLoading = false,
    this.acceptingOfferId,
    this.reorderGrace = const Duration(seconds: 2),
    this.emptyTitle = 'نبحث عن سائق قريب',
    this.emptyMessage =
        'وصل عرضك إلى السائقين حولك. أول رد يصل عادةً خلال أقل من دقيقة.',
    this.onAdjustProposal,
    this.adjustLabel = 'عدّل سعرك',
  });

  /// Already sorted by the caller — by fare, by ETA, by rating, whatever the
  /// screen decides. This widget does not sort; it only decides WHEN a new sort
  /// is allowed to become visible.
  final List<AlyDriverOffer> offers;

  final int riderProposalIqd;
  final ValueChanged<AlyDriverOffer> onAccept;

  /// True for the first seconds after the request, before any driver has had
  /// time to answer. Shows the skeleton rather than the empty state, because
  /// "nobody replied" is a claim we cannot yet make.
  final bool isLoading;

  /// The offer whose accept is in flight. Its button spins; every other accept
  /// is disabled, so a rider cannot claim two drivers.
  final String? acceptingOfferId;

  final Duration reorderGrace;

  final String emptyTitle;
  final String emptyMessage;

  /// Offered from the empty state, where raising the price is the one thing
  /// that actually changes the outcome.
  final VoidCallback? onAdjustProposal;
  final String adjustLabel;

  @override
  State<AlyOfferList> createState() => _AlyOfferListState();
}

class _AlyOfferListState extends State<AlyOfferList> {
  final List<AlyDriverOffer> _shown = <AlyDriverOffer>[];
  bool _touching = false;
  Timer? _grace;

  @override
  void initState() {
    super.initState();
    _shown.addAll(widget.offers);
  }

  @override
  void didUpdateWidget(AlyOfferList oldWidget) {
    super.didUpdateWidget(oldWidget);
    // No setState: we are already inside the rebuild the caller triggered.
    _merge();
  }

  @override
  void dispose() {
    _grace?.cancel();
    super.dispose();
  }

  bool get _pinned => _touching || (_grace?.isActive ?? false);

  void _merge() {
    if (!_pinned || _shown.isEmpty) {
      _shown
        ..clear()
        ..addAll(widget.offers);
      return;
    }

    final incoming = {for (final offer in widget.offers) offer.offerId: offer};
    final kept = <AlyDriverOffer>[
      for (final offer in _shown)
        if (incoming[offer.offerId] case final fresh?) fresh,
    ];
    final known = {for (final offer in kept) offer.offerId};
    for (final offer in widget.offers) {
      if (!known.contains(offer.offerId)) kept.add(offer);
    }

    _shown
      ..clear()
      ..addAll(kept);
  }

  void _onPointerDown(PointerDownEvent event) {
    _grace?.cancel();
    _touching = true;
  }

  void _onPointerRelease() {
    _touching = false;
    _grace?.cancel();
    _grace = Timer(widget.reorderGrace, () {
      if (!mounted) return;
      setState(_merge);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (widget.isLoading && _shown.isEmpty) {
      return const _OffersSkeleton();
    }

    if (_shown.isEmpty) {
      return _SearchingState(
        title: widget.emptyTitle,
        message: widget.emptyMessage,
        actionLabel: widget.adjustLabel,
        onAction: widget.onAdjustProposal,
      );
    }

    return Listener(
      // Translucent so the pointer is reported even when it lands on a gap
      // between two cards — a thumb resting between rows is still a thumb.
      behavior: HitTestBehavior.translucent,
      onPointerDown: _onPointerDown,
      onPointerUp: (_) => _onPointerRelease(),
      onPointerCancel: (_) => _onPointerRelease(),
      child: ListView.separated(
        shrinkWrap: true,
        padding: const EdgeInsetsDirectional.all(AlySpacing.gutter),
        itemCount: _shown.length,
        separatorBuilder: (_, __) => const SizedBox(height: AlySpacing.md),
        itemBuilder: (context, index) {
          final offer = _shown[index];
          final busy = widget.acceptingOfferId != null;

          return AlyDriverOfferCard(
            key: ValueKey<String>(offer.offerId),
            offer: offer,
            riderProposalIqd: widget.riderProposalIqd,
            isAccepting: widget.acceptingOfferId == offer.offerId,
            onAccept: busy ? null : () => widget.onAccept(offer),
          );
        },
      ),
    );
  }
}

/// The first seconds, in the shape of the cards that are coming.
class _OffersSkeleton extends StatelessWidget {
  const _OffersSkeleton();

  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsetsDirectional.symmetric(vertical: AlySpacing.sm),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AlySkeletonRow(),
            AlySkeletonRow(),
            AlySkeletonRow(),
          ],
        ),
      );
}

/// "Still looking" — the state a rider spends the most anxious seconds in.
///
/// Deliberately not [AlyEmptyState]: that widget says a thing is absent and
/// settled. This one says a thing is in progress, and the difference has to be
/// visible without reading, because a rider staring at a still screen after
/// sending a price assumes the app has hung and closes it. The pulse is the
/// only motion in this file that is not a state change, and it earns its place
/// by being the message.
class _SearchingState extends StatelessWidget {
  const _SearchingState({
    required this.title,
    required this.message,
    required this.actionLabel,
    this.onAction,
  });

  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Padding(
      padding: const EdgeInsetsDirectional.all(AlySpacing.xxl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const _PulsingDots(),
          const SizedBox(height: AlySpacing.lg),
          Semantics(
            liveRegion: true,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  style: AlyTypography.h3.copyWith(color: c.textPrimary),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AlySpacing.sm),
                Text(
                  message,
                  style: AlyTypography.body.copyWith(color: c.textSecondary),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
          if (onAction != null) ...[
            const SizedBox(height: AlySpacing.xl),
            AlyButton.secondary(
              label: actionLabel,
              onPressed: onAction,
              size: AlyButtonSize.medium,
              expand: false,
            ),
          ],
        ],
      ),
    );
  }
}

/// Three dots breathing in sequence. No spinner: a spinner means "the app is
/// working", and here it is the drivers who are.
class _PulsingDots extends StatefulWidget {
  const _PulsingDots();

  @override
  State<_PulsingDots> createState() => _PulsingDotsState();
}

class _PulsingDotsState extends State<_PulsingDots>
    with SingleTickerProviderStateMixin {
  // `late` because the ticker needs `this`, which does not exist at field
  // initialisation time.
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AlyMotion.shimmer,
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    Widget dot(double opacity) => Padding(
          padding: const EdgeInsetsDirectional.symmetric(
            horizontal: AlySpacing.xs,
          ),
          child: Container(
            width: AlySpacing.sm,
            height: AlySpacing.sm,
            decoration: BoxDecoration(
              color: c.primary.withValues(alpha: opacity),
              shape: BoxShape.circle,
            ),
          ),
        );

    // Reduce-motion keeps the three dots and drops the breathing. The user
    // still sees a "waiting" mark; they are only spared the animation they
    // asked the OS not to show them.
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [dot(0.4), dot(0.6), dot(0.4)],
      );
    }

    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        Widget staggered(int index) {
          final phase = (_controller.value + index * 0.18) % 1.0;
          final wave = 1 - (phase * 2 - 1).abs();
          return dot(0.3 + 0.7 * wave);
        }

        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [staggered(0), staggered(1), staggered(2)],
        );
      },
    );
  }
}

/// The driver's side of the negotiation.
///
/// ## Built for three seconds
///
/// A driver reads this at a junction. So the rider's price is the largest thing
/// on the sheet, the trip facts sit directly under it in one line each, and the
/// three actions are three visibly different weights: accept is the filled
/// primary and is always exactly one tap away, counter is outlined, reject is
/// text. A driver who is not sure taps nothing and the deadline decides — which
/// is the correct default, since a slow accept is worse for the rider than a
/// fast pass to the next driver.
///
/// ## Countering is a second step on purpose
///
/// The counter editor is revealed rather than shown, because a visible amount
/// field next to an accept button invites a driver to haggle on a fare they
/// would otherwise have taken. Revealing it costs the haggler one tap and saves
/// every other driver the distraction.
///
/// ## The deadline is the server's
///
/// [deadline] is an absolute time, not a duration, and the strip counts down
/// against the wall clock. A locally-started timer would drift with a slow
/// render or a backgrounded app and hand the driver a window the server has
/// already closed — they would tap accept and get a 409.
class AlyCounterOfferSheet extends StatefulWidget {
  const AlyCounterOfferSheet({
    required this.riderOfferIqd,
    required this.distanceM,
    required this.tripDuration,
    required this.deadline,
    required this.onAccept,
    required this.onCounter,
    required this.onReject,
    super.key,
    this.pickupAddress,
    this.dropoffAddress,
    this.stepIqd = _defaultStepIqd,
    this.maxCounterIqd,
    this.isSubmitting = false,
    this.onExpired,
  });

  /// What the rider is offering, in whole IQD.
  final int riderOfferIqd;

  final int distanceM;
  final Duration tripDuration;

  /// Absolute expiry, from the server.
  final DateTime deadline;

  final VoidCallback onAccept;

  /// Called with the driver's own price, in whole IQD.
  final ValueChanged<int> onCounter;

  final VoidCallback onReject;

  final String? pickupAddress;
  final String? dropoffAddress;

  final int stepIqd;

  /// Ceiling for a counter. Defaults to twice the rider's offer — a driver who
  /// wants more than that is declining, and should say so.
  final int? maxCounterIqd;

  /// True while any of the three decisions is in flight. Every action goes
  /// inert, because a second tap here is a second claim on the server.
  final bool isSubmitting;

  final VoidCallback? onExpired;

  @override
  State<AlyCounterOfferSheet> createState() => _AlyCounterOfferSheetState();
}

class _AlyCounterOfferSheetState extends State<AlyCounterOfferSheet> {
  bool _countering = false;
  bool _expired = false;
  int _counterIqd = 0;

  @override
  void initState() {
    super.initState();
    _expired = !widget.deadline.isAfter(DateTime.now());
    _counterIqd = _clampCounter(widget.riderOfferIqd + widget.stepIqd);
  }

  int get _maxCounterIqd {
    final ceiling = widget.maxCounterIqd ?? widget.riderOfferIqd * 2;
    return ceiling < widget.riderOfferIqd ? widget.riderOfferIqd : ceiling;
  }

  int _clampCounter(int value) =>
      value.clamp(widget.riderOfferIqd, _maxCounterIqd);

  void _onExpired() {
    if (_expired) return;
    setState(() => _expired = true);
    widget.onExpired?.call();
  }

  bool get _actionsEnabled => !_expired && !widget.isSubmitting;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Container(
      decoration: BoxDecoration(
        color: c.surfaceElevated,
        borderRadius: const BorderRadius.vertical(
          top: Radius.circular(AlyRadius.sheet),
        ),
        boxShadow: AlyElevation.medium,
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _DeadlineStrip(deadline: widget.deadline, onExpired: _onExpired),
              const SizedBox(height: AlySpacing.lg),
              Text(
                'عرض الراكب',
                style: AlyTypography.label.copyWith(color: c.textSecondary),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AlySpacing.xs),
              FittedBox(
                fit: BoxFit.scaleDown,
                child: FareText(
                  widget.riderOfferIqd,
                  style: AlyTypography.display.copyWith(color: c.textPrimary),
                ),
              ),
              const SizedBox(height: AlySpacing.lg),
              Wrap(
                alignment: WrapAlignment.center,
                spacing: AlySpacing.lg,
                runSpacing: AlySpacing.sm,
                children: [
                  _MetaItem(
                    icon: Icons.straighten_rounded,
                    text: _distanceLabel(widget.distanceM),
                  ),
                  _MetaItem(
                    icon: Icons.schedule_rounded,
                    text: _arabicMinutes(
                      (widget.tripDuration.inSeconds / 60).round(),
                    ),
                  ),
                ],
              ),
              if (widget.pickupAddress != null ||
                  widget.dropoffAddress != null) ...[
                const SizedBox(height: AlySpacing.lg),
                if (widget.pickupAddress != null)
                  _RouteLine(
                    tone: c.mapPickup,
                    label: 'الانطلاق',
                    address: widget.pickupAddress!,
                  ),
                if (widget.pickupAddress != null &&
                    widget.dropoffAddress != null)
                  const SizedBox(height: AlySpacing.sm),
                if (widget.dropoffAddress != null)
                  _RouteLine(
                    tone: c.mapDropoff,
                    label: 'الوجهة',
                    address: widget.dropoffAddress!,
                  ),
              ],
              const SizedBox(height: AlySpacing.xl),
              AnimatedSize(
                duration: AlyMotion.respecting(context, AlyMotion.medium),
                curve: AlyMotion.standard,
                alignment: AlignmentDirectional.topCenter.resolve(
                  Directionality.of(context),
                ),
                child: _countering ? _counterEditor(c) : _decisionActions(c),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _decisionActions(AlyColors c) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AlyButton(
            // The amount is in the label, not only above it: at a junction the
            // driver's eye goes to the button, and "قبول" alone would send them
            // back up the sheet to find out what they are accepting.
            label: 'قبول ${IqdFormatter.format(widget.riderOfferIqd)}',
            onPressed: _actionsEnabled ? widget.onAccept : null,
            isLoading: widget.isSubmitting,
            semanticLabel:
                'قبول الرحلة بمبلغ ${IqdFormatter.format(widget.riderOfferIqd)}',
          ),
          const SizedBox(height: AlySpacing.md),
          Row(
            children: [
              Expanded(
                child: AlyButton.secondary(
                  label: 'اعرض سعراً آخر',
                  size: AlyButtonSize.medium,
                  onPressed: _actionsEnabled
                      ? () => setState(() => _countering = true)
                      : null,
                ),
              ),
              const SizedBox(width: AlySpacing.md),
              Expanded(
                child: AlyButton(
                  label: 'رفض',
                  onPressed: _actionsEnabled ? widget.onReject : null,
                  variant: AlyButtonVariant.tertiary,
                  size: AlyButtonSize.medium,
                ),
              ),
            ],
          ),
          if (_expired) ...[
            const SizedBox(height: AlySpacing.md),
            Semantics(
              liveRegion: true,
              child: Text(
                'انتهت مهلة هذا الطلب',
                style: AlyTypography.bodySmall.copyWith(color: c.textTertiary),
                textAlign: TextAlign.center,
              ),
            ),
          ],
        ],
      );

  Widget _counterEditor(AlyColors c) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AlyFareProposal(
            valueIqd: _counterIqd,
            onChanged: (value) => setState(() => _counterIqd = value),
            suggestedIqd: widget.riderOfferIqd,
            minIqd: widget.riderOfferIqd,
            maxIqd: _maxCounterIqd,
            stepIqd: widget.stepIqd,
            enabled: _actionsEnabled,
            // The guidance line advises whoever is proposing; on this side of
            // the trade "higher gets accepted faster" is simply false.
            showGuidance: false,
            title: 'سعرك المضاد',
            rangeLabel: 'المدى المسموح لهذه الرحلة',
          ),
          const SizedBox(height: AlySpacing.md),
          AlyButton(
            label: 'أرسل ${IqdFormatter.format(_counterIqd)}',
            onPressed:
                _actionsEnabled ? () => widget.onCounter(_counterIqd) : null,
            isLoading: widget.isSubmitting,
            semanticLabel:
                'إرسال سعر مضاد بمبلغ ${IqdFormatter.format(_counterIqd)}',
          ),
          const SizedBox(height: AlySpacing.sm),
          AlyButton(
            label: 'رجوع',
            onPressed: widget.isSubmitting
                ? null
                : () => setState(() => _countering = false),
            variant: AlyButtonVariant.tertiary,
            size: AlyButtonSize.medium,
          ),
        ],
      );
}

/// The seconds left, as a number and as a draining bar.
///
/// Two channels for one fact: the bar is read in peripheral vision while the
/// driver is looking at the fare, and the number is there for anyone who wants
/// to be sure. It turns red at five seconds — the point where a driver should
/// stop reading and decide.
class _DeadlineStrip extends StatefulWidget {
  const _DeadlineStrip({required this.deadline, required this.onExpired});

  final DateTime deadline;
  final VoidCallback onExpired;

  @override
  State<_DeadlineStrip> createState() => _DeadlineStripState();
}

class _DeadlineStripState extends State<_DeadlineStrip> {
  Timer? _timer;
  Duration _remaining = Duration.zero;
  Duration _window = const Duration(seconds: 1);
  bool _fired = false;

  @override
  void initState() {
    super.initState();
    _remaining = _left();
    // The window is measured once, at mount: the bar shows the share of the
    // driver's OWN deadline that is left, which is the thing they are pacing
    // against.
    _window = _remaining > Duration.zero ? _remaining : const Duration(seconds: 1);
    // 250ms, not 1s: at a one-second cadence the displayed number can lag the
    // real deadline by almost a full second, and the whole window is fifteen.
    _timer = Timer.periodic(const Duration(milliseconds: 250), (_) => _tick());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Duration _left() {
    final left = widget.deadline.difference(DateTime.now());
    return left.isNegative ? Duration.zero : left;
  }

  void _tick() {
    final left = _left();
    if (left.inSeconds != _remaining.inSeconds && mounted) {
      setState(() => _remaining = left);
    }
    if (left == Duration.zero && !_fired) {
      _fired = true;
      _timer?.cancel();
      widget.onExpired();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final seconds = _remaining.inSeconds;
    final urgent = seconds <= 5;
    final tone = urgent ? c.error : c.primary;
    final fraction =
        (_remaining.inMilliseconds / _window.inMilliseconds).clamp(0.0, 1.0);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'الوقت المتبقي',
                style: AlyTypography.label.copyWith(color: c.textSecondary),
              ),
            ),
            const SizedBox(width: AlySpacing.sm),
            Text(
              _arabicSeconds(seconds),
              style: AlyTypography.numericSmall.copyWith(color: tone),
            ),
          ],
        ),
        const SizedBox(height: AlySpacing.sm),
        ExcludeSemantics(
          child: SizedBox(
            height: AlySpacing.xs,
            child: Stack(
              children: [
                Container(
                  decoration: BoxDecoration(
                    color: c.border,
                    borderRadius: BorderRadius.circular(AlyRadius.pill),
                  ),
                ),
                // Drains toward the END edge, so it empties left in Arabic and
                // right in English without a second layout.
                FractionallySizedBox(
                  alignment: AlignmentDirectional.centerStart,
                  widthFactor: fraction,
                  child: Container(
                    decoration: BoxDecoration(
                      color: tone,
                      borderRadius: BorderRadius.circular(AlyRadius.pill),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _RouteLine extends StatelessWidget {
  const _RouteLine({
    required this.tone,
    required this.label,
    required this.address,
  });

  final Color tone;
  final String label;
  final String address;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsetsDirectional.only(top: AlySpacing.xs),
          child: Container(
            width: AlySpacing.sm,
            height: AlySpacing.sm,
            decoration: BoxDecoration(color: tone, shape: BoxShape.circle),
          ),
        ),
        const SizedBox(width: AlySpacing.sm),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: AlyTypography.caption.copyWith(color: c.textTertiary),
              ),
              Text(
                address,
                style: AlyTypography.body.copyWith(color: c.textPrimary),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Arabic counts its minutes in four forms, not two.
///
/// "1 دقائق" and "2 دقيقة" both read as machine output to an Iraqi user, and
/// this string sits on the card they use to choose a driver. The dual form
/// (دقيقتان) is not optional in written Arabic.
String _arabicMinutes(int minutes) => switch (minutes) {
      <= 0 => 'أقل من دقيقة',
      1 => 'دقيقة',
      2 => 'دقيقتان',
      >= 3 && <= 10 => '$minutes دقائق',
      _ => '$minutes دقيقة',
    };

String _arabicSeconds(int seconds) => switch (seconds) {
      <= 0 => 'انتهى الوقت',
      1 => 'ثانية',
      2 => 'ثانيتان',
      >= 3 && <= 10 => '$seconds ثوانٍ',
      _ => '$seconds ثانية',
    };

/// Under a kilometre a driver thinks in metres; over it, in tenths of a
/// kilometre. "0.4 كم" is a number nobody says out loud in Baghdad.
String _distanceLabel(int meters) => meters < 1000
    ? '$meters متر'
    : '${(meters / 1000).toStringAsFixed(1)} كم';
