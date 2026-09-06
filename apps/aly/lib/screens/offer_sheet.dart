import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The offer sheet: accept or decline, against a deadline.
///
/// Two things matter here and both are about the race in CLAUDE.md §5.1:
///
///  * **Losing the race is a normal outcome, not an error.** Another driver
///    accepting first produces `rideAlreadyClaimed`, which is shown as "الرحلة
///    لم تعد متاحة" and closes the sheet. Rendering that as a crash or a
///    generic failure would teach drivers the app is broken.
///
///  * **The countdown tracks the SERVER's deadline.** A locally-started timer
///    drifts, and a driver who taps accept at what their screen says is 2
///    seconds left gets a 409 they cannot explain.
class OfferSheet extends StatefulWidget {
  const OfferSheet({required this.offer, required this.api, super.key});

  final RideOffer offer;
  final ApiClient api;

  @override
  State<OfferSheet> createState() => _OfferSheetState();
}

class _OfferSheetState extends State<OfferSheet> {
  bool _busy = false;
  String? _error;

  Future<void> _accept() async {
    // A driver accepts one-handed, in a moving car, against a 15-second
    // deadline — often without looking. The confirmation has to be felt.
    unawaited(HapticFeedback.mediumImpact());
    setState(() {
      _busy = true;
      _error = null;
    });

    final strings = AppStrings.of(context);

    try {
      await widget.api.acceptRide(widget.offer.rideId);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      if (!mounted) return;

      // Losing the claim race is expected under load, not a fault.
      if (error.problem == ApiProblem.rideAlreadyClaimed ||
          error.problem == ApiProblem.invalidRideTransition ||
          error.problem == ApiProblem.notFound) {
        _closeWith(strings.rideNoLongerAvailable);
        return;
      }

      setState(() {
        _busy = false;
        _error = error.problem == ApiProblem.network
            ? strings.noInternet
            : strings.somethingWentWrong;
      });
    }
  }

  Future<void> _decline() async {
    // Lighter than accept: the same gesture must not feel like the same
    // decision.
    unawaited(HapticFeedback.selectionClick());
    setState(() => _busy = true);
    try {
      await widget.api.declineRide(widget.offer.rideId);
    } on ApiException {
      // A failed decline is harmless: the offer expires on its own and the
      // server moves to the next candidate either way.
    } finally {
      if (mounted) Navigator.of(context).pop(false);
    }
  }

  void _closeWith(String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
    Navigator.of(context).pop(false);
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final offer = widget.offer;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsetsDirectional.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  strings.newRideRequest,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                DeadlineCountdown(
                  expiresAt: offer.expiresAt,
                  onExpired: () {
                    if (mounted && !_busy) _closeWith(strings.offerExpired);
                  },
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.lg),

            // The fare is the number the driver decides on, and the distance
            // is the one that decides whether it is worth it. Side by side,
            // because a driver reads both in the same glance or neither.
            Row(
              children: [
                Expanded(
                  child: _OfferStat(
                    label: strings.fare,
                    child: FareText(offer.estimatedFareIqd, large: true),
                  ),
                ),
                Expanded(
                  child: _OfferStat(
                    label: strings.distance,
                    child: Text(
                      '${(offer.distanceM / 1000).toStringAsFixed(1)} '
                      '${strings.kilometreShort}',
                      style: AlyTypography.h3.copyWith(
                        color: AlyColors.of(context).textPrimary,
                      ),
                      textDirection: TextDirection.ltr,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.lg),

            _Leg(
              icon: Icons.trip_origin,
              color: AppColors.primary,
              label: strings.setPickup,
              address: offer.pickupAddress,
              trailing: '${(offer.distanceM / 1000).toStringAsFixed(1)} km',
            ),
            const SizedBox(height: AppSpacing.sm),
            _Leg(
              icon: Icons.place,
              color: AppColors.danger,
              label: strings.setDestination,
              address: offer.dropoffAddress,
            ),

            if (_error != null) ...[
              const SizedBox(height: AppSpacing.md),
              StatusBanner(message: _error!, tone: BannerTone.danger),
            ],

            const SizedBox(height: AppSpacing.lg),
            AlyButton(
              label: strings.acceptRequest,
              onPressed: _accept,
              isLoading: _busy,
            ),
            const SizedBox(height: AppSpacing.sm),
            AlyButton.secondary(
              label: strings.decline,
              onPressed: _busy ? null : _decline,
            ),
          ],
        ),
      ),
    );
  }
}

class _Leg extends StatelessWidget {
  const _Leg({
    required this.icon,
    required this.color,
    required this.label,
    this.address,
    this.trailing,
  });

  final IconData icon;
  final Color color;
  final String label;
  final String? address;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: color),
        const SizedBox(width: AppSpacing.md),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: Theme.of(context)
                    .textTheme
                    .bodyMedium
                    ?.copyWith(color: AppColors.textSecondary),
              ),
              if (address != null)
                Text(address!, style: Theme.of(context).textTheme.bodyMedium),
            ],
          ),
        ),
        if (trailing != null)
          Text(trailing!, textDirection: TextDirection.ltr),
      ],
    );
  }
}

/// One labelled figure on the offer sheet.
class _OfferStat extends StatelessWidget {
  const _OfferStat({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: AlyTypography.label.copyWith(color: c.textSecondary)),
        const SizedBox(height: AlySpacing.xs),
        child,
      ],
    );
  }
}
