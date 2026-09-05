import 'dart:async';

import 'package:flutter/material.dart';
import 'package:rideapp_core/src/design/components/buttons.dart';
import 'package:rideapp_core/src/design/tokens/colors.dart';
import 'package:rideapp_core/src/design/tokens/metrics.dart';
import 'package:rideapp_core/src/design/tokens/typography.dart';
import 'package:rideapp_core/src/design/widgets.dart';
import 'package:rideapp_core/src/l10n/strings.dart';

/// Driver mode — an operating console, not a dashboard.
///
/// ## The reading conditions this file is designed for
///
/// The driver is parked, engine running, phone in a windscreen cradle or in one
/// hand, sunlight on the glass, and they are looking at this screen for about a
/// second between fares. Everything here follows from that:
///
///   - **One thing is loud.** [AlyOnlineToggle] is the only element allowed to
///     carry a saturated fill. If two things shout, the driver has to read.
///   - **Numbers before prose.** Earnings, days left, trip count — the figure
///     is the headline and the sentence is the caption, never the reverse.
///   - **Every blocked state names the next action.** "حسابك موقوف" is a fact.
///     "تواصل مع الدعم لإعادة التفعيل" is a fact the driver can act on. A
///     console that reports state without offering an exit is a support call.
///
/// Nothing here derives anything from `DateTime.now()`. Days remaining, online
/// time and earnings all arrive as values from the server, because the client
/// clock and the server clock disagree often enough — and a driver told they
/// have one day left when the server says zero will lose a shift to it.

/// A tone lane for a driver-console row, resolved against [AlyColors].
///
/// Kept private and small on purpose: the console needs exactly four levels of
/// "how bad is this", and letting callers pass arbitrary colours is how a
/// screen ends up with three different reds.
enum _Tone { danger, warning, info, neutral }

extension on _Tone {
  Color foreground(AlyColors c) => switch (this) {
        _Tone.danger => c.error,
        _Tone.warning => c.warning,
        _Tone.info => c.info,
        _Tone.neutral => c.textSecondary,
      };

  Color muted(AlyColors c) => switch (this) {
        _Tone.danger => c.errorMuted,
        _Tone.warning => c.warningMuted,
        _Tone.info => c.infoMuted,
        _Tone.neutral => c.surfaceSunken,
      };
}

/// `03/09/2026`.
///
/// Numeric rather than `d MMM y`, and deliberately not routed through
/// `intl`'s Arabic date symbols: those need `initializeDateFormatting` to have
/// been called by the host app, and a design-system component that throws
/// `LocaleDataException` inside someone else's widget test is a trap. A
/// zero-padded numeric date is unambiguous in one glance, which is the whole
/// requirement here.
String _numericDate(DateTime value) {
  final local = value.toLocal();
  final day = local.day.toString().padLeft(2, '0');
  final month = local.month.toString().padLeft(2, '0');
  return '$day/$month/${local.year}';
}

/// `5 س 45 د`.
///
/// Forced RTL at the render site (see [_StatCell]) so the units stay attached
/// to their own numbers when the app is running in English.
String _formatOnlineTime(Duration online) {
  final hours = online.inHours;
  final minutes = online.inMinutes.remainder(60);
  if (hours == 0) return '$minutes د';
  return '$hours س $minutes د';
}

/// Online / offline. The most important control in the product.
///
/// ## Why this is not a `Switch`
///
/// A platform switch is a settings affordance: small, ambiguous at a glance
/// (which side is on?), and it reports its new state the instant it is dragged
/// — before the server has agreed. This control is the driver's shift button.
/// It is full width, it states its state in words rather than by the position
/// of a thumb, and it is *only* green once the server has confirmed.
///
/// ## The three states
///
/// | State | Fill | Why |
/// |---|---|---|
/// | offline | `surface`, 2pt `borderStrong` | quiet. Nothing is happening. |
/// | going online | `surface` + spinner | the server has not agreed yet |
/// | online | `online`, filled | visible in sunlight, from a metre away |
///
/// The offline state is deliberately NOT filled with [AlyColors.offline]:
/// white on a mid grey is around 2:1, which is unreadable through a windscreen.
/// The asymmetry is the design — offline is quiet, online shouts.
///
/// ## Double-tap safety
///
/// Going online is not idempotent from the driver's point of view: two taps in
/// flight can leave the app showing offline while the server has them online,
/// which means offers arriving for a driver who thinks they have finished. Two
/// guards, because one is not enough:
///
///   1. `isBusy` from the caller closes the control for the whole round trip.
///   2. An internal latch closes it for the handoff window — the frames between
///      the tap and the caller actually setting `isBusy`. A caller that
///      `await`s the request before calling `setState` has no `isBusy` during
///      that await, and that is precisely where the second tap lands.
///
/// The latch releases itself after `_handoffWindow` so that a caller which
/// ignores the callback entirely cannot wedge the driver's shift button. Once
/// `isBusy` is true, guard 1 has taken over and the latch is redundant.
class AlyOnlineToggle extends StatefulWidget {
  const AlyOnlineToggle({
    required this.isOnline,
    required this.onChanged,
    super.key,
    this.isBusy = false,
  });

  /// The state the SERVER has confirmed — never an optimistic local guess.
  final bool isOnline;

  /// Called with the requested new state. Null disables the control, which is
  /// what a caller does when [AlyBlockerList] has something to say.
  final ValueChanged<bool>? onChanged;

  /// A request is in flight.
  final bool isBusy;

  @override
  State<AlyOnlineToggle> createState() => _AlyOnlineToggleState();
}

class _AlyOnlineToggleState extends State<AlyOnlineToggle> {
  /// Long enough to cover a caller that awaits before it reports busy, short
  /// enough that a driver never stands in front of a dead button. Not an
  /// [AlyMotion] value: this is a concurrency guard, not an animation.
  static const Duration _handoffWindow = Duration(milliseconds: 600);

  Timer? _handoff;
  bool _pressed = false;
  bool _latched = false;

  bool get _enabled => widget.onChanged != null && !widget.isBusy && !_latched;

  @override
  void didUpdateWidget(covariant AlyOnlineToggle oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The caller has answered — either by reporting the request in flight or by
    // reporting the new state. The latch has done its job.
    if (oldWidget.isBusy != widget.isBusy || oldWidget.isOnline != widget.isOnline) {
      _handoff?.cancel();
      _handoff = null;
      _latched = false;
    }
  }

  @override
  void dispose() {
    _handoff?.cancel();
    super.dispose();
  }

  void _onTap() {
    final onChanged = widget.onChanged;
    if (onChanged == null || widget.isBusy || _latched) return;

    // Latched BEFORE the callback runs, so a synchronous re-entrant rebuild
    // still sees a closed control.
    setState(() => _latched = true);
    _handoff = Timer(_handoffWindow, () {
      if (mounted) setState(() => _latched = false);
    });
    onChanged(!widget.isOnline);
  }

  String get _statusLabel {
    if (widget.isBusy) {
      return widget.isOnline ? 'جارٍ إيقاف الاتصال…' : 'جارٍ الاتصال…';
    }
    return widget.isOnline ? 'أنت متصل' : 'أنت غير متصل';
  }

  String get _hint {
    if (widget.onChanged == null) return 'لا يمكنك تغيير حالتك الآن.';
    if (widget.isBusy) return 'لحظة واحدة، نحدّث حالتك على الخادم.';
    return widget.isOnline
        ? 'تصلك طلبات الرحلات الآن. أبقِ التطبيق يعمل.'
        : 'اضغط لتصبح متاحاً وتبدأ باستقبال الطلبات.';
  }

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final disabled = widget.onChanged == null;
    final online = widget.isOnline && !disabled;

    final fill = disabled
        ? c.surfaceSunken
        : online
            ? c.online
            : c.surface;
    final foreground = disabled
        ? c.textDisabled
        : online
            ? c.textOnColor
            : c.textPrimary;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          button: true,
          toggled: widget.isOnline,
          enabled: _enabled,
          label: _statusLabel,
          hint: _hint,
          // The inner text is already announced by this node; without the
          // exclusion a screen reader reads the same sentence twice.
          excludeSemantics: true,
          child: GestureDetector(
            onTapDown: _enabled ? (_) => setState(() => _pressed = true) : null,
            onTapUp: _enabled ? (_) => setState(() => _pressed = false) : null,
            onTapCancel: _enabled ? () => setState(() => _pressed = false) : null,
            onTap: _onTap,
            child: AnimatedScale(
              scale: _pressed ? 0.98 : 1,
              duration: AlyMotion.respecting(context, AlyMotion.fast),
              curve: AlyMotion.standard,
              child: AnimatedContainer(
                duration: AlyMotion.respecting(context, AlyMotion.fast),
                curve: AlyMotion.standard,
                constraints: const BoxConstraints(minHeight: AlySpacing.tapTarget),
                padding: const EdgeInsetsDirectional.symmetric(
                  horizontal: AlySpacing.lg,
                  vertical: AlySpacing.lg,
                ),
                decoration: BoxDecoration(
                  color: fill,
                  borderRadius: BorderRadius.circular(AlyRadius.pill),
                  border: online
                      ? null
                      : Border.all(
                          color: disabled ? c.border : c.borderStrong,
                          width: 2,
                        ),
                  boxShadow: online ? AlyElevation.low : AlyElevation.none,
                ),
                child: Row(
                  children: [
                    // A fixed slot for the dot and the spinner alike. If the
                    // two had different sizes the label would slide sideways
                    // the moment the driver tapped.
                    SizedBox(
                      width: 20,
                      height: 20,
                      child: Center(
                        child: widget.isBusy
                            ? SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.2,
                                  color: foreground,
                                ),
                              )
                            : Container(
                                width: 14,
                                height: 14,
                                decoration: BoxDecoration(
                                  color: online ? c.textOnColor : c.offline,
                                  shape: BoxShape.circle,
                                ),
                              ),
                      ),
                    ),
                    const SizedBox(width: AlySpacing.md),
                    Expanded(
                      child: Text(
                        _statusLabel,
                        style: AlyTypography.h3.copyWith(color: foreground),
                      ),
                    ),
                    const SizedBox(width: AlySpacing.sm),
                    Icon(
                      Icons.power_settings_new_rounded,
                      size: 24,
                      color: foreground,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: AlySpacing.sm),
        // Outside the fill, not inside it. On the green fill this 13pt line
        // would sit at about 3.3:1 in dark mode — fine for the 20pt label
        // above, below AA for a sentence. Moving it onto the surface is
        // cheaper than inventing a token to fix it.
        Padding(
          padding: const EdgeInsetsDirectional.symmetric(horizontal: AlySpacing.sm),
          child: Text(
            _hint,
            style: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
          ),
        ),
      ],
    );
  }
}

/// One figure and its caption. The console's unit of measure.
class _StatCell extends StatelessWidget {
  const _StatCell({required this.value, required this.label, this.rtlValue = false});

  final String value;
  final String label;

  /// Force RTL on the value. Used for `5 س 45 د`, where an LTR paragraph would
  /// detach each unit from its number.
  final bool rtlValue;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          value,
          style: AlyTypography.numeric.copyWith(color: c.textPrimary),
          textDirection: rtlValue ? TextDirection.rtl : TextDirection.ltr,
        ),
        Text(
          label,
          style: AlyTypography.caption.copyWith(color: c.textSecondary),
        ),
      ],
    );
  }
}

/// What the driver has made today.
///
/// ## Why the figure is the whole card
///
/// This is the number a driver checks a dozen times a shift, usually without
/// reading anything else on the screen. It gets [AlyTypography.display] —
/// tabular, so it does not jitter when a fare lands while they are looking at
/// it — and everything else on the card is deliberately a caption.
///
/// ## The comparison is optional and it is not a judgement
///
/// Down against yesterday renders in [AlyColors.textSecondary], not in
/// [AlyColors.error]. A slow morning is not an error state, and colouring it
/// red turns a neutral fact into an accusation aimed at someone whose income
/// this is.
///
/// Money is `int` IQD throughout and reaches the screen only via [FareText]
/// (CLAUDE.md §6.1).
class AlyEarningsCard extends StatelessWidget {
  const AlyEarningsCard({
    required this.todayIqd,
    required this.tripCount,
    required this.onlineTime,
    super.key,
    this.yesterdayIqd,
    this.onViewStatement,
  });

  /// Net earnings today, in whole dinars, as the server computed them.
  final int todayIqd;

  final int tripCount;

  /// Time spent online today.
  final Duration onlineTime;

  /// Yesterday's total. Null hides the comparison entirely — an absent
  /// comparison is better than a comparison against a zero we invented.
  final int? yesterdayIqd;

  final VoidCallback? onViewStatement;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final yesterday = yesterdayIqd;

    return Container(
      padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(AlyRadius.lg),
        border: Border.all(color: c.border),
        boxShadow: AlyElevation.low,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'أرباح اليوم',
            style: AlyTypography.label.copyWith(color: c.textSecondary),
          ),
          const SizedBox(height: AlySpacing.xs),
          // Scaled down only when it would otherwise clip. A driver at 200%
          // text scale still gets the largest number the screen can hold, and
          // the card never overflows on a 360pt phone.
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: AlignmentDirectional.centerStart,
            child: FareText(
              todayIqd,
              style: AlyTypography.display.copyWith(color: c.textPrimary),
            ),
          ),
          if (yesterday != null) ...[
            const SizedBox(height: AlySpacing.sm),
            _Delta(todayIqd: todayIqd, yesterdayIqd: yesterday),
          ],
          const SizedBox(height: AlySpacing.lg),
          Divider(color: c.border, height: 1, thickness: 1),
          const SizedBox(height: AlySpacing.lg),
          // Wrap, not Row: at a large text scale two stat columns no longer fit
          // side by side on a narrow phone, and stacking them is correct where
          // squeezing them is not.
          Wrap(
            spacing: AlySpacing.xxl,
            runSpacing: AlySpacing.md,
            children: [
              _StatCell(value: '$tripCount', label: 'الرحلات'),
              _StatCell(
                value: _formatOnlineTime(onlineTime),
                label: 'مدة الاتصال',
                rtlValue: true,
              ),
            ],
          ),
          if (onViewStatement != null) ...[
            const SizedBox(height: AlySpacing.md),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: AlyButton(
                label: 'كشف الحساب',
                onPressed: onViewStatement,
                variant: AlyButtonVariant.tertiary,
                size: AlyButtonSize.medium,
                icon: Icons.receipt_long_rounded,
                expand: false,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Today against yesterday, with a direction.
class _Delta extends StatelessWidget {
  const _Delta({required this.todayIqd, required this.yesterdayIqd});

  final int todayIqd;
  final int yesterdayIqd;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final difference = todayIqd - yesterdayIqd;

    final (IconData icon, Color tone, String suffix) = switch (difference) {
      > 0 => (Icons.trending_up_rounded, c.success, 'أكثر من أمس'),
      < 0 => (Icons.trending_down_rounded, c.textSecondary, 'أقل من أمس'),
      _ => (Icons.trending_flat_rounded, c.textSecondary, 'مثل أمس'),
    };

    if (difference == 0) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 18, color: tone),
          const SizedBox(width: AlySpacing.xs),
          Text(suffix, style: AlyTypography.bodySmall.copyWith(color: tone)),
        ],
      );
    }

    return Wrap(
      spacing: AlySpacing.xs,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Icon(icon, size: 18, color: tone),
        FareText(
          difference.abs(),
          style: AlyTypography.numericSmall.copyWith(color: tone),
        ),
        Text(suffix, style: AlyTypography.bodySmall.copyWith(color: c.textSecondary)),
      ],
    );
  }
}

/// The subscription that gates the driver's ability to work.
///
/// ## Why this is a card and not a line in a settings screen
///
/// In a subscription model the expiry date is not an account detail, it is the
/// difference between earning today and not. It gets the same visual weight as
/// a warning because that is what it is, and it escalates in three steps rather
/// than two so that "expiring" is a state the driver sees for a week rather
/// than a surprise they meet on the morning it stops.
///
/// ## Why `daysRemaining` is passed in
///
/// It is not computed from [expiresAt] here. `DateTime.now()` on the handset is
/// whatever the handset believes, and the server is the thing that will
/// actually refuse the ride. Telling a driver they have one day left when the
/// server has already expired them is worse than telling them nothing.
class AlySubscriptionCard extends StatelessWidget {
  const AlySubscriptionCard({
    required this.planName,
    required this.expiresAt,
    required this.daysRemaining,
    super.key,
    this.onRenew,
    this.isRenewing = false,
  });

  final String planName;

  /// Shown, never used for arithmetic. See the class comment.
  final DateTime expiresAt;

  /// From the server. Zero or negative means expired.
  final int daysRemaining;

  final VoidCallback? onRenew;

  /// A renewal is in flight. [AlyButton] holds its own width while loading, so
  /// nothing under the card moves.
  final bool isRenewing;

  bool get _isExpired => daysRemaining <= 0;

  /// Seven days, because a driver paid weekly needs to see this coming before
  /// the week they would have paid for it.
  bool get _isExpiringSoon => daysRemaining > 0 && daysRemaining <= 7;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    final tone = _isExpired
        ? _Tone.danger
        : _isExpiringSoon
            ? _Tone.warning
            : _Tone.neutral;

    // CLAUDE.md §8: no user-facing string is hardcoded. This component held
    // nine Arabic literals with no English path at all, and its widget tests
    // asserted them - so mounting it on a screen would have shipped the
    // violation rather than revealed it.
    final strings = AppStrings.of(context);

    final headline =
        _isExpired ? strings.subscriptionExpired : strings.subscriptionRemaining(daysRemaining);

    final consequence = _isExpired
        ? strings.subscriptionHintExpired
        : _isExpiringSoon
            ? strings.subscriptionHintExpiringSoon
            : strings.subscriptionHintActive;

    final headlineColour = tone == _Tone.neutral ? c.textPrimary : tone.foreground(c);

    return Container(
      padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
      decoration: BoxDecoration(
        color: tone == _Tone.neutral ? c.surface : tone.muted(c),
        borderRadius: BorderRadius.circular(AlyRadius.lg),
        border: Border.all(
          color: tone == _Tone.neutral ? c.border : tone.foreground(c),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                _isExpired ? Icons.event_busy_rounded : Icons.card_membership_rounded,
                size: 22,
                color: tone.foreground(c),
              ),
              const SizedBox(width: AlySpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      planName,
                      style: AlyTypography.label.copyWith(color: c.textSecondary),
                    ),
                    const SizedBox(height: AlySpacing.xs),
                    // The state, at heading weight. This is the line the driver
                    // reads; the date below it is the evidence.
                    Text(
                      headline,
                      style: AlyTypography.h3.copyWith(color: headlineColour),
                    ),
                    const SizedBox(height: AlySpacing.xs),
                    Wrap(
                      spacing: AlySpacing.xs,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          _isExpired
                              ? strings.subscriptionExpiredOn
                              : strings.subscriptionExpiresOn,
                          style: AlyTypography.body.copyWith(color: c.textSecondary),
                        ),
                        // Its own LTR run so the day, month and year cannot be
                        // reordered by the surrounding Arabic paragraph.
                        Text(
                          _numericDate(expiresAt),
                          style: AlyTypography.numericSmall.copyWith(
                            color: c.textPrimary,
                          ),
                          textDirection: TextDirection.ltr,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AlySpacing.sm),
          Text(
            consequence,
            style: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
          ),
          if (onRenew != null) ...[
            const SizedBox(height: AlySpacing.md),
            // Expired gets the primary fill because it is the only thing the
            // driver can usefully do on this screen. Anything earlier is
            // secondary, so it does not compete with the online toggle.
            if (_isExpired)
              AlyButton(
                label: strings.renewSubscription,
                onPressed: onRenew,
                size: AlyButtonSize.medium,
                icon: Icons.autorenew_rounded,
                isLoading: isRenewing,
              )
            else
              AlyButton.secondary(
                label: strings.renewSubscription,
                onPressed: onRenew,
                size: AlyButtonSize.medium,
                icon: Icons.autorenew_rounded,
                isLoading: isRenewing,
              ),
          ],
        ],
      ),
    );
  }
}

/// One reason the driver cannot go online, in a form they can act on.
@immutable
class _Blocker {
  const _Blocker({
    required this.icon,
    required this.tone,
    required this.title,
    required this.action,
    this.actionLabel,
    this.code,
  });

  final IconData icon;
  final _Tone tone;

  /// What is wrong. One line.
  final String title;

  /// What the driver should DO about it. Never a restatement of [title].
  final String action;

  /// Null where there is genuinely nothing to press — a pending review is
  /// waiting, and a button that "hurries it up" would be a lie.
  final String? actionLabel;

  /// Set only for a code this build does not recognise, so the driver can read
  /// it out to support.
  final String? code;
}

/// The icon and tone for one blocker code. The WORDS live in [AppStrings].
///
/// ## Why an unknown code renders instead of throwing
///
/// The server ships weekly, the Play Store review does not. A driver on last
/// month's build WILL receive a code this switch has never seen, and the two
/// tempting behaviours - throw, or filter it out - are both worse than a
/// generic row. Throwing puts a red screen in front of a driver who is trying
/// to work. Filtering silently produces the worst possible screen: a toggle
/// that does nothing and a list explaining why that is empty.
///
/// So the default branch renders a real row, tells the driver to call support,
/// and prints the raw code for support to look up. The app degrades; it does
/// not break.
///
/// ## Why the sentences moved out
///
/// They were Arabic literals here, which CLAUDE.md §8 forbids and which left
/// the English build showing Arabic. Icon and tone stay - those are design
/// decisions, not copy, and they do not vary by language.
_Blocker _blockerFor(String code, AppStrings strings) => _Blocker(
      icon: switch (code) {
        'ACCOUNT_DISABLED' => Icons.no_accounts_rounded,
        'NOT_A_DRIVER' => Icons.person_off_rounded,
        'APPROVAL_PENDING' => Icons.hourglass_top_rounded,
        'APPROVAL_REJECTED' => Icons.cancel_rounded,
        'SUSPENDED' => Icons.pause_circle_filled_rounded,
        'DOCUMENTS_INCOMPLETE' => Icons.description_rounded,
        'SUBSCRIPTION_REQUIRED' => Icons.card_membership_rounded,
        _ => Icons.help_outline_rounded,
      },
      tone: switch (code) {
        'ACCOUNT_DISABLED' ||
        'NOT_A_DRIVER' ||
        'APPROVAL_REJECTED' ||
        'SUSPENDED' =>
          _Tone.danger,
        'APPROVAL_PENDING' => _Tone.info,
        'DOCUMENTS_INCOMPLETE' || 'SUBSCRIPTION_REQUIRED' => _Tone.warning,
        _ => _Tone.neutral,
      },
      title: strings.blockerTitle(code),
      action: strings.blockerAction(code),
      actionLabel: strings.blockerActionLabel(code),
      // Shown only for a code this build does not recognise, so the driver can
      // read it out to support.
      code: _isKnownBlocker(code) ? null : code,
    );

bool _isKnownBlocker(String code) => const {
      'ACCOUNT_DISABLED',
      'NOT_A_DRIVER',
      'APPROVAL_PENDING',
      'APPROVAL_REJECTED',
      'SUSPENDED',
      'DOCUMENTS_INCOMPLETE',
      'SUBSCRIPTION_REQUIRED',
    }.contains(code);

/// Why this driver cannot go online, and what to do about each reason.
///
/// Takes the server's machine-readable codes rather than sentences, so the
/// wording lives in the app and can be fixed without a backend deploy — and so
/// that a code the app does not know still produces a usable row (see
/// [_blockerFor]).
///
/// Renders nothing at all for an empty list, so a caller can place it
/// unconditionally above the toggle without an `if` at every call site.
class AlyBlockerList extends StatelessWidget {
  const AlyBlockerList({
    required this.codes,
    super.key,
    this.title,
    this.onAction,
  });

  /// Server codes, in the server's own order — it sends the most blocking
  /// first. Repeats are collapsed: the same reason twice is a server hiccup,
  /// not two problems.
  final List<String> codes;

  /// Defaults to [AppStrings.cannotGoOnlineNow] when null - it cannot be a
  /// const default because it depends on the locale.
  final String? title;

  /// Given the code of the row that was pressed. Null renders the list as a
  /// read-only explanation, which is correct on a screen with nowhere to go.
  final void Function(String code)? onAction;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final strings = AppStrings.of(context);
    final unique = <String>{...codes}.toList();
    if (unique.isEmpty) return const SizedBox.shrink();

    return Container(
      padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(AlyRadius.lg),
        border: Border.all(color: c.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.block_rounded, size: 22, color: c.error),
              const SizedBox(width: AlySpacing.sm),
              Expanded(
                child: Text(
                  title ?? strings.cannotGoOnlineNow,
                  style: AlyTypography.h3.copyWith(color: c.textPrimary),
                ),
              ),
            ],
          ),
          for (final code in unique) ...[
            const SizedBox(height: AlySpacing.lg),
            _BlockerRow(
              code: code,
              blocker: _blockerFor(code, strings),
              onAction: onAction,
            ),
          ],
        ],
      ),
    );
  }
}

class _BlockerRow extends StatelessWidget {
  const _BlockerRow({required this.code, required this.blocker, this.onAction});

  final String code;
  final _Blocker blocker;
  final void Function(String code)? onAction;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final onAction = this.onAction;
    final actionLabel = blocker.actionLabel;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsetsDirectional.all(AlySpacing.sm),
          decoration: BoxDecoration(
            color: blocker.tone.muted(c),
            borderRadius: BorderRadius.circular(AlyRadius.pill),
          ),
          child: Icon(blocker.icon, size: 20, color: blocker.tone.foreground(c)),
        ),
        const SizedBox(width: AlySpacing.md),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                blocker.title,
                style: AlyTypography.bodyLarge.copyWith(
                  color: c.textPrimary,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: AlySpacing.xs),
              // The line that matters. Every row has one, including the
              // unknown-code row.
              Text(
                blocker.action,
                style: AlyTypography.body.copyWith(color: c.textSecondary),
              ),
              if (blocker.code != null) ...[
                const SizedBox(height: AlySpacing.xs),
                Text(
                  blocker.code!,
                  style: AlyTypography.caption.copyWith(color: c.textTertiary),
                  // A machine code, not prose: LTR in both languages.
                  textDirection: TextDirection.ltr,
                ),
              ],
              if (onAction != null && actionLabel != null) ...[
                const SizedBox(height: AlySpacing.sm),
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: AlyButton(
                    label: actionLabel,
                    onPressed: () => onAction(code),
                    variant: AlyButtonVariant.tertiary,
                    size: AlyButtonSize.medium,
                    expand: false,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
