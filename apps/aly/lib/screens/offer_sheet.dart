import 'package:flutter/material.dart';
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
                  strings.newRideOffer,
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

            // The fare is the number the driver decides on. It gets the
            // largest type on the sheet.
            Center(child: FareText(offer.estimatedFareIqd, large: true)),
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
            PrimaryButton(
              label: strings.accept,
              onPressed: _accept,
              busy: _busy,
              color: AppColors.online,
            ),
            const SizedBox(height: AppSpacing.sm),
            OutlinedButton(
              onPressed: _busy ? null : _decline,
              child: Text(strings.decline),
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
