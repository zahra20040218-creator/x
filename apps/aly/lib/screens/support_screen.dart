import 'package:flutter/material.dart';
import 'package:rideapp_aly/screens/ride_history_screen.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Where a rider goes when something went wrong.
///
/// ## Why this is a router and not a form
///
/// Every complaint this app can file is a dispute, and `openDispute` takes a
/// `rideId` — there is no such thing here as a problem detached from a trip.
/// So the categories explain what each covers and then hand the rider the list
/// of their rides to choose from; the sheet they already know
/// (`report_problem_sheet.dart`) does the filing.
///
/// The alternative — a free-text box that posts somewhere — would be a second
/// complaint channel with no reference number, no ride attached, and nothing
/// on the server to receive it.
///
/// ## Why these four categories
///
/// They are the design's, and they are chosen so that every one of them maps
/// onto reasons the server already accepts. `DisputeReason` has five values
/// and no category here implies a sixth: a heading with nothing behind it is
/// how a support screen starts lying about what it can do.
///
/// In-app chat is on CLAUDE.md §2's OUT list, so there is none. A phone row is
/// absent for a plainer reason: no support number exists in configuration, and
/// printing one I invented would be worse than printing none.
class SupportScreen extends StatelessWidget {
  const SupportScreen({required this.api, super.key});

  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final c = AlyColors.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(strings.supportTitle)),
      body: ListView(
        padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
        children: [
          Text(
            strings.supportIssues,
            style: AlyTypography.label.copyWith(color: c.textSecondary),
          ),
          const SizedBox(height: AlySpacing.md),

          _Category(
            icon: Icons.directions_car_rounded,
            title: strings.supportRides,
            body: strings.supportRidesBody,
            onTap: () => _pickRide(context),
          ),
          _Category(
            icon: Icons.account_balance_wallet_rounded,
            title: strings.supportWallet,
            body: strings.supportWalletBody,
            onTap: () => _pickRide(context),
          ),
          _Category(
            icon: Icons.badge_rounded,
            title: strings.supportAccount,
            body: strings.supportAccountBody,
            onTap: () => _pickRide(context),
          ),
          _Category(
            icon: Icons.help_rounded,
            title: strings.supportOther,
            body: strings.supportPickRide,
            onTap: () => _pickRide(context),
          ),
        ],
      ),
    );
  }

  /// Every category lands here, because every category ends in the same act:
  /// naming the ride it is about.
  void _pickRide(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => RideHistoryScreen(api: api),
      ),
    );
  }
}

class _Category extends StatelessWidget {
  const _Category({
    required this.icon,
    required this.title,
    required this.body,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String body;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Padding(
      padding: const EdgeInsetsDirectional.only(bottom: AlySpacing.md),
      child: AlyCard(
        onTap: onTap,
        padding: const EdgeInsetsDirectional.all(AlySpacing.md),
        child: Row(
          children: [
            Icon(icon, color: c.primary),
            const SizedBox(width: AlySpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: AlyTypography.title.copyWith(color: c.textPrimary),
                  ),
                  Text(
                    body,
                    style:
                        AlyTypography.bodySmall.copyWith(color: c.textSecondary),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_left_rounded, color: c.textTertiary),
          ],
        ),
      ),
    );
  }
}
