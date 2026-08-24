import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Driver earnings arithmetic.
///
/// The mistake these guard against is not a crash. It is a plausible-looking
/// number: double-entry means every event writes two balancing rows, so a
/// naive sum reports roughly twice what a driver earned, and nobody notices
/// until a driver checks.
LedgerEntry entry({
  required String account,
  required String direction,
  required int amount,
  String? rideId,
  DateTime? at,
}) =>
    LedgerEntry(
      id: '$account-$direction-$amount-${at?.toIso8601String() ?? ''}',
      transactionId: 'tx-1',
      rideId: rideId,
      accountType: account,
      direction: direction,
      amountIqd: IqdAmount(amount),
      description: '',
      createdAt: at ?? DateTime.now(),
    );

void main() {
  group('the double-count', () {
    test('counts only the driver wallet side of a balanced transaction', () {
      // A 5,000 cash ride: the wallet is credited, cash-held is debited.
      // Summing both would report 10,000.
      final entries = [
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 5000, rideId: 'r1'),
        entry(account: 'DRIVER_CASH_HELD', direction: 'DEBIT', amount: 5000, rideId: 'r1'),
      ];

      expect(EarningsSummary.from(entries).allTime.value, 5000);
    });

    test('ignores platform revenue entirely', () {
      final entries = [
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 5000, rideId: 'r1'),
        entry(account: 'PLATFORM_REVENUE', direction: 'CREDIT', amount: 750, rideId: 'r1'),
      ];

      expect(EarningsSummary.from(entries).allTime.value, 5000);
    });
  });

  group('signed arithmetic', () {
    test('a commission debit subtracts', () {
      final entries = [
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 5000, rideId: 'r1'),
        entry(account: 'DRIVER_WALLET', direction: 'DEBIT', amount: 750, rideId: 'r1'),
      ];

      // Not 5,750. A debit that added would show a driver more than they made
      // and the shortfall would surface at payout.
      expect(EarningsSummary.from(entries).allTime.value, 4250);
    });

    test('handles a net negative wallet movement', () {
      final entries = [
        entry(account: 'DRIVER_WALLET', direction: 'DEBIT', amount: 2000, rideId: 'r1'),
      ];
      expect(EarningsSummary.from(entries).allTime.value, -2000);
    });
  });

  group('ride count', () {
    test('counts distinct rides, not entries', () {
      // One ride, three entries: fare, commission, adjustment.
      final entries = [
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 5000, rideId: 'r1'),
        entry(account: 'DRIVER_WALLET', direction: 'DEBIT', amount: 750, rideId: 'r1'),
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 100, rideId: 'r1'),
      ];

      expect(EarningsSummary.from(entries).rideCount, 1);
    });

    test('counts two rides as two', () {
      final entries = [
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 5000, rideId: 'r1'),
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 3000, rideId: 'r2'),
      ];
      expect(EarningsSummary.from(entries).rideCount, 2);
    });

    test('an entry with no ride (a manual top-up) counts as no ride', () {
      final entries = [
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 10000),
      ];
      final summary = EarningsSummary.from(entries);

      expect(summary.rideCount, 0);
      // But the money still counts.
      expect(summary.allTime.value, 10000);
    });
  });

  group('today', () {
    test('excludes yesterday', () {
      final yesterday = DateTime.now().subtract(const Duration(days: 2));
      final entries = [
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 5000, at: yesterday),
        entry(account: 'DRIVER_WALLET', direction: 'CREDIT', amount: 3000),
      ];

      final summary = EarningsSummary.from(entries);
      expect(summary.today.value, 3000);
      expect(summary.allTime.value, 8000);
    });

    test('an empty ledger is zero, not null and not a crash', () {
      final summary = EarningsSummary.from(const <LedgerEntry>[]);
      expect(summary.today.value, 0);
      expect(summary.allTime.value, 0);
      expect(summary.rideCount, 0);
    });
  });
}
