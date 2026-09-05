import 'dart:async';

import 'package:flutter/material.dart';
import 'package:rideapp_core/src/design/theme.dart';
import 'package:rideapp_core/src/l10n/strings.dart';
import 'package:rideapp_core/src/models/models.dart';
import 'package:rideapp_core/src/money/iqd.dart';

/// Widgets both apps need. CLAUDE.md §1 - duplicating any of these in
/// `apps/rider` or `apps/driver` is a defect.

/// The fare, rendered the way CLAUDE.md §8 specifies: `12,500 د.ع`.
///
/// Takes an `int`, not a `double`. A widget that accepted a double would let a
/// float reach the screen, which is the visible end of the money bug the whole
/// system is built to prevent.
class FareText extends StatelessWidget {
  const FareText(this.amountIqd, {super.key, this.style, this.large = false});

  final int amountIqd;
  final TextStyle? style;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Text(
      IqdFormatter.format(amountIqd),
      style: style ??
          (large ? theme.textTheme.headlineMedium : theme.textTheme.titleLarge),
      // The number reads left-to-right even inside Arabic text; without this
      // the currency mark can end up on the wrong side of the digits.
      textDirection: TextDirection.ltr,
    );
  }
}

/// The itemised fare. Shown to both parties so a dispute starts from the same
/// arithmetic.
class FareBreakdownCard extends StatelessWidget {
  const FareBreakdownCard({required this.breakdown, required this.total, super.key});

  final FareBreakdown breakdown;
  final int total;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Card(
      child: Padding(
        padding: const EdgeInsetsDirectional.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(strings.fareBreakdown, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AppSpacing.sm),
            _row(context, strings.baseFare, breakdown.baseIqd),
            _row(context, strings.distanceCharge, breakdown.distanceIqd),
            _row(context, strings.timeCharge, breakdown.timeIqd),
            if (breakdown.minimumAppliedIqd > 0)
              _row(context, strings.minimumFare, breakdown.minimumAppliedIqd),
            if (breakdown.roundingIqd > 0)
              _row(context, strings.rounding, breakdown.roundingIqd),
            const Divider(height: AppSpacing.lg),
            _row(context, strings.total, total, bold: true),
          ],
        ),
      ),
    );
  }

  Widget _row(BuildContext context, String label, int amount, {bool bold = false}) {
    final style = bold
        ? Theme.of(context).textTheme.labelLarge
        : Theme.of(context).textTheme.bodyMedium;

    return Padding(
      padding: const EdgeInsetsDirectional.symmetric(vertical: AppSpacing.xs),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: style),
          Text(
            IqdFormatter.format(amount),
            style: style,
            textDirection: TextDirection.ltr,
          ),
        ],
      ),
    );
  }
}

/// The counterparty card: who is picking you up, or who you are collecting.
///
/// Shows a name, rating and vehicle. There is NO phone number here, and no
/// field to put one in - `PublicUser` does not carry one
/// (ACCEPTANCE_CHECKLIST.md check 5).
class CounterpartyCard extends StatelessWidget {
  const CounterpartyCard({required this.user, super.key});

  final PublicUser user;

  @override
  Widget build(BuildContext context) {
    final vehicle = user.vehicle;

    return Card(
      child: Padding(
        padding: const EdgeInsetsDirectional.all(AppSpacing.md),
        child: Row(
          children: [
            CircleAvatar(
              radius: 24,
              backgroundColor: AppColors.surfaceVariant,
              child: Text(
                user.displayName.characters.first,
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(user.displayName,
                      style: Theme.of(context).textTheme.titleLarge,),
                  if (vehicle != null)
                    Text(
                      '${vehicle.model} · ${vehicle.color} · ${vehicle.plate}',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            color: AppColors.textSecondary,
                          ),
                    ),
                ],
              ),
            ),
            if (user.rating != null)
              Row(
                children: [
                  const Icon(Icons.star, size: 18, color: AppColors.accent),
                  const SizedBox(width: AppSpacing.xs),
                  Text(
                    user.rating!.toStringAsFixed(1),
                    textDirection: TextDirection.ltr,
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

/// A primary action sized for one-handed use in a moving car.
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    required this.label,
    required this.onPressed,
    super.key,
    this.busy = false,
    this.color,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      // Disabled while busy, so a double tap cannot fire the action twice.
      // The idempotency key protects the server; this protects the user from
      // seeing two spinners.
      onPressed: busy ? null : onPressed,
      style: color == null
          ? null
          : ElevatedButton.styleFrom(backgroundColor: color),
      child: busy
          ? const SizedBox(
              height: 22,
              width: 22,
              child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white),
            )
          : Text(label),
    );
  }
}

/// Status banner, used by both apps for connection and error states.
class StatusBanner extends StatelessWidget {
  const StatusBanner({
    required this.message,
    super.key,
    this.tone = BannerTone.info,
    this.onRetry,
  });

  final String message;
  final BannerTone tone;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final color = switch (tone) {
      BannerTone.info => AppColors.primary,
      BannerTone.warning => AppColors.warning,
      BannerTone.danger => AppColors.danger,
    };

    return Container(
      width: double.infinity,
      padding: const EdgeInsetsDirectional.all(AppSpacing.md),
      color: color.withValues(alpha: 0.1),
      child: Row(
        children: [
          Icon(
            switch (tone) {
              BannerTone.info => Icons.info_outline,
              BannerTone.warning => Icons.warning_amber_outlined,
              BannerTone.danger => Icons.error_outline,
            },
            color: color,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(message)),
          if (onRetry != null)
            TextButton(onPressed: onRetry, child: Text(strings.retry)),
        ],
      ),
    );
  }
}

enum BannerTone { info, warning, danger }

/// A countdown against a server deadline.
///
/// Counts down to [expiresAt] rather than from a locally-started timer, so a
/// slow render or a backgrounded app cannot give the driver more time than the
/// server is actually honouring.
class DeadlineCountdown extends StatefulWidget {
  const DeadlineCountdown({
    required this.expiresAt,
    required this.onExpired,
    super.key,
  });

  final DateTime expiresAt;
  final VoidCallback onExpired;

  @override
  State<DeadlineCountdown> createState() => _DeadlineCountdownState();
}

class _DeadlineCountdownState extends State<DeadlineCountdown> {
  Timer? _timer;
  Duration _remaining = Duration.zero;
  bool _fired = false;

  @override
  void initState() {
    super.initState();
    _remaining = _left();
    // 250ms rather than 1s: at a 1s cadence the displayed number can lag the
    // real deadline by almost a full second, which matters when the whole
    // window is 15.
    _timer = Timer.periodic(const Duration(milliseconds: 250), (_) => _onTick());
  }

  Duration _left() {
    final left = widget.expiresAt.difference(DateTime.now());
    return left.isNegative ? Duration.zero : left;
  }

  void _onTick() {
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
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final seconds = _remaining.inSeconds;
    return Text(
      '$seconds',
      textDirection: TextDirection.ltr,
      style: Theme.of(context).textTheme.headlineMedium?.copyWith(
            color: seconds <= 5 ? AppColors.danger : AppColors.textPrimary,
          ),
    );
  }
}
