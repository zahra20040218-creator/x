import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// What the driver has earned.
///
/// Reads the ledger rather than a stored counter. `CLAUDE.md` §6.4 makes the
/// balance derived — `SUM(credits) - SUM(debits)` — precisely so no screen can
/// display a number that drifted from the entries behind it.
///
/// ## The arithmetic that is easy to get wrong
///
/// Every transaction writes at least two rows summing to zero, so a statement
/// that adds `amountIqd` shows a driver roughly double what they earned. Only
/// the driver-wallet credits are income; `signedIqd` on the model exists to
/// make the distinction hard to miss.
class EarningsScreen extends StatefulWidget {
  const EarningsScreen({required this.api, super.key});

  final ApiClient api;

  @override
  State<EarningsScreen> createState() => _EarningsScreenState();
}

class _EarningsScreenState extends State<EarningsScreen> {
  ViewState<_Earnings> _state = const ViewState<_Earnings>.loading();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _state = const ViewState<_Earnings>.loading());
    try {
      // Balance and statement together: a balance with no entries behind it is
      // a number the driver cannot check.
      final balance = await widget.api.wallet();
      final entries = await widget.api.walletEntries(limit: 100);

      if (!mounted) return;
      final earnings = _Earnings(
        balance: balance.balanceIqd,
        summary: EarningsSummary.from(entries),
        entries: entries,
      );

      setState(() => _state = entries.isEmpty
          ? const ViewState<_Earnings>.empty()
          : ViewState<_Earnings>.success(earnings));
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _state = ViewState<_Earnings>.error(
            error.detail ?? error.problem.slug,
            canRetry: !error.requiresReauthentication,
          ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(strings.earnings)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: AsyncView<_Earnings>(
          state: _state,
          onRetry: _load,
          empty: (context) => EmptyView(message: strings.noEarningsYet),
          success: (context, data) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              Row(
                children: [
                  Expanded(
                    child: _Stat(
                      label: strings.totalEarnings,
                      amount: data.balance,
                      emphasis: true,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: _Stat(label: strings.todayEarnings, amount: data.summary.today),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.sm),
              _Stat(label: strings.completedRides, count: data.summary.rideCount),

              const SizedBox(height: AppSpacing.lg),
              Text(strings.statement, style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: AppSpacing.sm),

              ...data.entries.map((entry) => _EntryTile(entry: entry)),
            ],
          ),
        ),
      ),
    );
  }
}

/// What this screen renders.
///
/// The arithmetic lives in `EarningsSummary` in packages/core, where it is a
/// pure function with its own tests — the double-entry double-count is not a
/// mistake worth risking inside a widget.
class _Earnings {
  const _Earnings({
    required this.balance,
    required this.summary,
    required this.entries,
  });

  /// Authoritative, from the server, which sums the WHOLE ledger.
  final IqdAmount balance;

  /// Derived from the fetched page only.
  final EarningsSummary summary;

  final List<LedgerEntry> entries;
}

class _Stat extends StatelessWidget {
  const _Stat({
    required this.label,
    this.amount,
    this.count,
    this.emphasis = false,
  });

  final String label;
  final IqdAmount? amount;
  final int? count;
  final bool emphasis;

  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: AppSpacing.xs),
              if (amount != null)
                FareText(amount!, large: emphasis)
              else
                Text(
                  '${count ?? 0}',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
            ],
          ),
        ),
      );
}

class _EntryTile extends StatelessWidget {
  const _EntryTile({required this.entry});

  final LedgerEntry entry;

  @override
  Widget build(BuildContext context) {
    final credit = entry.isCredit;

    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        credit ? Icons.arrow_downward : Icons.arrow_upward,
        color: credit ? AppColors.success : AppColors.textSecondary,
        size: 20,
      ),
      title: Text(
        entry.description.isEmpty ? entry.accountType : entry.description,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        formatDateTimeAr(entry.createdAt),
        style: Theme.of(context).textTheme.bodySmall,
      ),
      trailing: Text(
        // The sign is carried explicitly. A statement where a debit and a
        // credit look identical is a statement nobody can reconcile.
        '${credit ? '+' : '−'}${entry.amountIqd.value}',
        textDirection: TextDirection.ltr,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: credit ? AppColors.success : AppColors.textSecondary,
              fontWeight: FontWeight.w600,
            ),
      ),
    );
  }
}
