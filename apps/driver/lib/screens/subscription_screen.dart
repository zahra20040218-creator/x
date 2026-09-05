import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The driver's subscription, and what it costs to renew.
///
/// ## Why this screen exists
///
/// The server has been able to REFUSE a driver for a lapsed subscription since
/// migration 0011, and until now nothing could tell them so. `CapabilityService`
/// returns `SUBSCRIPTION_REQUIRED`, `AlySubscriptionCard` and `AlyBlockerList`
/// were built and widget-tested to render exactly that — and no screen mounted
/// either of them, no Dart code called `/me/capabilities`, and the driver app
/// had no settings screen to put them on. The enforcement half shipped without
/// the explanation half, which is the worst of the two orders: a toggle that
/// refuses with a generic error.
///
/// ## Capabilities, not just the subscription
///
/// It loads both. A driver whose subscription lapsed is usually blocked for
/// exactly one reason, but a driver who is ALSO unapproved or suspended would
/// otherwise renew, discover they are still blocked, and have learned nothing.
/// CLAUDE.md §1.1 is explicit that the server returns every blocker and the app
/// shows the full list.
///
/// ## There is no Buy button, and that is deliberate
///
/// v1 collects in cash: an operator takes the notes and records the period from
/// the admin panel (`POST /admin/drivers/{id}/subscription`). CLAUDE.md §2
/// keeps a live payment gateway out of scope and DECISIONS.md D-019 records why
/// it stays out until there are drivers already paying. A "pay now" button here
/// would be a promise the system cannot keep — so the screen shows the price
/// and tells the driver how payment actually works.
class SubscriptionScreen extends StatefulWidget {
  const SubscriptionScreen({required this.api, super.key});

  final ApiClient api;

  @override
  State<SubscriptionScreen> createState() => _SubscriptionScreenState();
}

class _SubscriptionScreenState extends State<SubscriptionScreen> {
  ViewState<_SubscriptionView> _state = const ViewState<_SubscriptionView>.loading();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _state = const ViewState<_SubscriptionView>.loading());

    try {
      // Both, and in this order for a reason: the subscription is what the
      // driver came to see, and the capabilities are what tell them whether
      // renewing it will actually let them work.
      final subscription = await widget.api.mySubscription();
      final plans = await widget.api.subscriptionPlans();
      final capabilities = await widget.api.capabilities();

      if (!mounted) return;
      setState(
        () => _state = ViewState<_SubscriptionView>.success(
          _SubscriptionView(
            subscription: subscription,
            plans: plans,
            blockers: capabilities.driver.blockers,
          ),
        ),
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(
        () => _state = ViewState<_SubscriptionView>.error(
          error.detail ?? error.problem.slug,
          canRetry: !error.requiresReauthentication,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(strings.subscriptionTitle)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: AsyncView<_SubscriptionView>(
          state: _state,
          onRetry: _load,
          // Never reached: `_load` always produces a success, because "no
          // subscription" is a normal answer with plans to show, not an empty
          // screen. Supplied because AsyncView requires it.
          empty: (context) => EmptyView(message: strings.noActiveSubscription),
          success: (context, data) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              if (data.subscription != null)
                AlySubscriptionCard(
                  planName: _planName(context, data, data.subscription!.planCode),
                  expiresAt: data.subscription!.expiresAt,
                  // Computed here against the real clock rather than stored, so
                  // a screen left open overnight does not show yesterday's
                  // number. No onRenew: there is nothing to press yet.
                  daysRemaining: data.subscription!.daysRemainingAt(DateTime.now()),
                )
              else
                _NoSubscription(strings: strings),

              // Only the reasons that are NOT the subscription itself. Repeating
              // "your subscription is not active" directly under a card that
              // already says so is noise, and it buries the blocker the driver
              // has not seen.
              if (data.otherBlockers.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.md),
                AlyBlockerList(codes: data.otherBlockers),
              ],

              if (data.plans.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.lg),
                Text(
                  strings.availablePlans,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: AppSpacing.sm),
                for (final plan in data.plans)
                  _PlanRow(plan: plan, strings: strings),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  strings.subscriptionPurchaseHint,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// The plan's own name where the server still lists it, falling back to the
  /// stored code.
  ///
  /// A driver whose plan was deactivated after they bought it still holds a
  /// valid period, and showing them a blank name — or crashing on a missing
  /// lookup — would be worse than showing the code.
  String _planName(BuildContext context, _SubscriptionView data, String code) {
    final language = AppStrings.of(context).languageCode;
    for (final plan in data.plans) {
      if (plan.code == code) return plan.nameFor(language);
    }
    return code;
  }
}

class _SubscriptionView {
  const _SubscriptionView({
    required this.subscription,
    required this.plans,
    required this.blockers,
  });

  final DriverSubscription? subscription;
  final List<SubscriptionPlan> plans;
  final List<String> blockers;

  List<String> get otherBlockers =>
      blockers.where((code) => code != 'SUBSCRIPTION_REQUIRED').toList();
}

class _NoSubscription extends StatelessWidget {
  const _NoSubscription({required this.strings});

  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(strings.noActiveSubscription, style: theme.textTheme.titleMedium),
            const SizedBox(height: AppSpacing.xs),
            // Deliberately not alarming. Subscriptions ship disabled
            // (`subscription_required` is seeded false), so for most drivers
            // today this state is normal and blocks nothing.
            Text(strings.noActiveSubscriptionHint, style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

class _PlanRow extends StatelessWidget {
  const _PlanRow({required this.plan, required this.strings});

  final SubscriptionPlan plan;
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      child: ListTile(
        title: Text(plan.nameFor(strings.languageCode)),
        subtitle: Text(strings.planDuration(plan.durationDays)),
        // `IqdFormatter` and not string interpolation: CLAUDE.md §8 fixes the
        // display as `12,500 د.ع` — thousands separator, no decimals, ever.
        trailing: Text(
          IqdFormatter.format(plan.priceIqd),
          style: theme.textTheme.titleMedium,
          textDirection: TextDirection.ltr,
        ),
      ),
    );
  }
}
