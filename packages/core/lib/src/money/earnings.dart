import 'package:rideapp_core/src/l10n/dates.dart';
import 'package:rideapp_core/src/models/models.dart';
import 'package:rideapp_core/src/money/iqd.dart';

/// Driver earnings, derived from the ledger.
///
/// A pure function over entries, separate from any widget, because the
/// arithmetic here has one genuinely dangerous mistake in it and that mistake
/// is invisible in a screenshot.
///
/// ## The double-count
///
/// Every financial event writes at least two rows summing to zero
/// (CLAUDE.md §6.2). A cash ride credits `DRIVER_WALLET` and debits
/// `DRIVER_CASH_HELD` for the same amount. Summing `amountIqd` across all
/// entries therefore reports roughly **twice** what the driver earned, and the
/// number looks plausible enough that nobody questions it until a driver does.
///
/// Only `DRIVER_WALLET` rows are the driver's money, and within those only the
/// signed value is meaningful — a commission debit must subtract.
class EarningsSummary {
  const EarningsSummary({
    required this.today,
    required this.allTime,
    required this.rideCount,
  });

  factory EarningsSummary.from(Iterable<LedgerEntry> entries) {
    // The driver's own account only. See the class comment.
    final wallet = entries.where((e) => e.accountType == 'DRIVER_WALLET');

    var today = 0;
    var allTime = 0;
    final rides = <String>{};

    for (final entry in wallet) {
      allTime += entry.signedIqd;
      if (isToday(entry.createdAt)) today += entry.signedIqd;
      // Distinct rides: one ride can produce several entries (fare, then a
      // commission debit, then perhaps an adjustment). Counting entries would
      // inflate the ride count.
      final rideId = entry.rideId;
      if (rideId != null) rides.add(rideId);
    }

    return EarningsSummary(
      today: IqdAmount(today),
      allTime: IqdAmount(allTime),
      rideCount: rides.length,
    );
  }

  /// Net movement on the driver's wallet since local midnight.
  final IqdAmount today;

  /// Net movement across every entry supplied.
  ///
  /// NOT the authoritative balance — that comes from the server, which sums
  /// the whole ledger rather than one page of it. This is what the fetched
  /// page accounts for, and the two differ once the statement is paginated.
  final IqdAmount allTime;

  /// Distinct rides represented in these entries.
  final int rideCount;
}
