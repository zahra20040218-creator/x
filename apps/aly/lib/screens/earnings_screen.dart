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

  /// Accumulated across pages, so the summary is computed over everything
  /// loaded rather than only the newest page.
  final List<LedgerEntry> _entries = [];
  String? _cursor;
  bool _loadingMore = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _state = const ViewState<_Earnings>.loading();
      _entries.clear();
      _cursor = null;
    });

    try {
      // Balance and statement together: a balance with no entries behind it is
      // a number the driver cannot check.
      final balance = await widget.api.wallet();
      final page = await widget.api.walletEntries();

      if (!mounted) return;
      _entries.addAll(page.items);
      _cursor = page.nextCursor;
      _balance = balance.balanceIqd;

      setState(() => _state = _entries.isEmpty
          ? const ViewState<_Earnings>.empty()
          : ViewState<_Earnings>.success(_snapshot()),);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _state = ViewState<_Earnings>.error(
            error.detail ?? error.problem.slug,
            canRetry: !error.requiresReauthentication,
          ),);
    }
  }

  /// Fetch the next page.
  ///
  /// Without this the statement stops at the first page with nothing to say so
  /// — the driver sees a plausible list and no sign that anything is missing.
  Future<void> _loadMore() async {
    final cursor = _cursor;
    if (cursor == null || _loadingMore) return;

    setState(() => _loadingMore = true);
    try {
      final page = await widget.api.walletEntries(cursor: cursor);
      if (!mounted) return;
      setState(() {
        _entries.addAll(page.items);
        _cursor = page.nextCursor;
        _state = ViewState<_Earnings>.success(_snapshot());
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      // Inline, not a screen replacement: the pages already loaded are still
      // correct and still worth reading.
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.detail ?? error.problem.slug)),
      );
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  IqdAmount _balance = IqdAmount.zero;

  _Earnings _snapshot() => _Earnings(
        balance: _balance,
        summary: EarningsSummary.from(_entries),
        entries: List.unmodifiable(_entries),
        hasMore: _cursor != null,
      );

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
          // Slivers, not a plain ListView: the statement paginates, and a
          // ListView built from a `children:` list constructs every row it has
          // ever loaded on each frame. The header and the footer are fixed, so
          // only the entries need to be lazy — which is exactly the split
          // SliverList.builder expresses.
          success: (context, data) => CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.all(AppSpacing.md),
                sliver: SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // The balance, on the one coloured surface of the
                      // screen. Screen 4 of the new design: it is the single
                      // number a driver opens this for, and everything else
                      // here explains how it got that way.
                      Container(
                        padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
                        decoration: BoxDecoration(
                          color: AlyColors.of(context).primary,
                          borderRadius: BorderRadius.circular(AlyRadius.lg),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              strings.balance,
                              style: AlyTypography.label.copyWith(
                                color: AlyColors.of(context).onPrimary,
                              ),
                            ),
                            const SizedBox(height: AlySpacing.xs),
                            FareText(
                              data.balance,
                              style: AlyTypography.display.copyWith(
                                color: AlyColors.of(context).onPrimary,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: AlySpacing.md),
                      Row(
                        children: [
                          Expanded(
                            child: _Stat(
                              label: strings.todayEarnings,
                              amount: data.summary.today,
                            ),
                          ),
                          const SizedBox(width: AppSpacing.sm),
                          Expanded(
                            child: _Stat(
                              label: strings.completedRides,
                              count: data.summary.rideCount,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      Text(
                        strings.statement,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: AppSpacing.sm),
                    ],
                  ),
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.md,
                ),
                sliver: SliverList.builder(
                  itemCount: data.entries.length,
                  itemBuilder: (context, i) =>
                      _EntryTile(entry: data.entries[i]),
                ),
              ),
              if (data.hasMore)
                SliverPadding(
                  padding: const EdgeInsets.all(AppSpacing.md),
                  sliver: SliverToBoxAdapter(
                    child: AlyButton.secondary(
                      label: _loadingMore ? strings.loading : strings.loadMore,
                      onPressed: _loadingMore ? null : _loadMore,
                    ),
                  ),
                ),
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
    required this.hasMore,
  });

  /// Authoritative, from the server, which sums the WHOLE ledger.
  final IqdAmount balance;

  /// Derived from the fetched page only.
  final EarningsSummary summary;

  final List<LedgerEntry> entries;

  /// Whether the server has more pages behind this one.
  final bool hasMore;
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, this.amount, this.count});

  final String label;
  final IqdAmount? amount;
  final int? count;

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
                FareText(amount!)
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
        credit ? Icons.arrow_downward_rounded : Icons.arrow_upward_rounded,
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
        //
        // Through IqdFormatter, not `.value`: a bare `10500` next to a
        // `10,500 د.ع` on the card above is the same money written two ways,
        // and the reader has to work out that it is. CLAUDE.md §8 gives one
        // format for every figure on the screen — thousands separated, the
        // currency named, no decimals.
        '${credit ? '+' : '−'}${IqdFormatter.format(entry.amountIqd.value)}',
        textDirection: TextDirection.ltr,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: credit ? AppColors.success : AppColors.textSecondary,
              fontWeight: FontWeight.w600,
            ),
      ),
    );
  }
}
