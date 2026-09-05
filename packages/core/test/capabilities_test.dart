import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Reading a capability answer, and a driver-mode refusal.
///
/// CLAUDE.md §1.1 makes the mode a SERVER decision, and the app renders what
/// the server says. Until now no Dart code called `/me/capabilities` and no
/// build knew the `driver-mode-unavailable` slug, so every refusal that was not
/// about documents fell through to a generic error. These cover the translation
/// boundary in both directions: the payload the server sends, and the codes an
/// app must survive not recognising.

ApiException refusal(Map<String, dynamic> body) => ApiException(
      problem: ApiProblem.driverModeUnavailable,
      status: 403,
      detail: 'Driver mode is not available for this account.',
      extra: {'type': 'driver-mode-unavailable', ...body},
    );

void main() {
  group('ApiProblem', () {
    test('parses the driver-mode-unavailable slug', () {
      // The whole defect in one assertion: this returned `unknown` before, so
      // an expired subscription reached the driver as "something went wrong".
      expect(
        ApiProblem.fromType('driver-mode-unavailable'),
        ApiProblem.driverModeUnavailable,
      );
    });

    test('still parses it when the server sends a full URI', () {
      expect(
        ApiProblem.fromType('https://aly.iq/problems/driver-mode-unavailable'),
        ApiProblem.driverModeUnavailable,
      );
    });
  });

  group('reading blockers off a refusal', () {
    test('returns every blocker in the order the server sent them', () {
      final error = refusal({
        'blockers': ['SUSPENDED', 'SUBSCRIPTION_REQUIRED'],
      });

      // Order is the server's: it sends the most blocking first, and a driver
      // who fixes one reason and is still blocked has learned nothing.
      expect(error.driverBlockers, ['SUSPENDED', 'SUBSCRIPTION_REQUIRED']);
    });

    test('carries the suspension reason an operator typed', () {
      final error = refusal({
        'blockers': ['SUSPENDED'],
        'suspendedReason': 'شكاوى متكررة',
      });

      expect(error.suspendedReason, 'شكاوى متكررة');
    });

    test('is empty, not null, for a problem that carries no blockers', () {
      // So a caller can read it unconditionally rather than guarding every use.
      final other = ApiException(
        problem: ApiProblem.conflict,
        status: 409,
        detail: 'nope',
      );
      expect(other.driverBlockers, isEmpty);
      expect(other.suspendedReason, isNull);
    });

    test('survives a malformed blockers member instead of throwing', () {
      // An unauthenticated-adjacent path returning junk must not crash a
      // driver's app mid-shift.
      expect(refusal({'blockers': 'SUSPENDED'}).driverBlockers, isEmpty);
      expect(refusal({'blockers': [1, 2]}).driverBlockers, isEmpty);
      expect(refusal({}).driverBlockers, isEmpty);
    });
  });

  group('Capabilities.fromJson', () {
    test('reads the full driver verdict', () {
      final capabilities = Capabilities.fromJson({
        'userId': 'u1',
        'canRide': true,
        'driver': {
          'allowed': false,
          'blockers': ['SUBSCRIPTION_REQUIRED'],
          'suspendedReason': null,
          'missingDocuments': <String>[],
          'expiredDocuments': <String>[],
          'rejectedDocuments': <String>[],
          'subscriptionExpiresAt': '2026-03-01T00:00:00.000Z',
        },
      });

      expect(capabilities.canRide, isTrue);
      expect(capabilities.driver.allowed, isFalse);
      expect(capabilities.driver.blockers, ['SUBSCRIPTION_REQUIRED']);
      expect(
        capabilities.driver.subscriptionExpiresAt,
        DateTime.parse('2026-03-01T00:00:00.000Z'),
      );
    });

    test('defaults a missing driver block to not-allowed rather than allowed', () {
      // Failing open here would let a client enter Driver mode the server is
      // about to refuse. The safe direction for an authorisation answer is off.
      final capabilities = Capabilities.fromJson({'userId': 'u1', 'canRide': true});
      expect(capabilities.driver.allowed, isFalse);
      expect(capabilities.driver.blockers, isEmpty);
    });

    test('reads a plain rider, who is not a driver at all', () {
      final capabilities = Capabilities.fromJson({
        'userId': 'u2',
        'canRide': true,
        'driver': {
          'allowed': false,
          'blockers': ['NOT_A_DRIVER'],
          'missingDocuments': <String>[],
          'expiredDocuments': <String>[],
          'rejectedDocuments': <String>[],
        },
      });

      expect(capabilities.canRide, isTrue);
      expect(capabilities.driver.blockers, ['NOT_A_DRIVER']);
      expect(capabilities.driver.subscriptionExpiresAt, isNull);
    });
  });

  group('SubscriptionPlan', () {
    test('reads money as a whole-dinar integer', () {
      final plan = SubscriptionPlan.fromJson({
        'code': 'MONTHLY_25K',
        'nameAr': 'اشتراك شهري',
        'nameEn': 'Monthly subscription',
        'priceIqd': 25000,
        'durationDays': 30,
      });

      expect(plan.priceIqd, const IqdAmount(25000));
      expect(plan.durationDays, 30);
    });

    test('picks the name for the app language', () {
      final plan = SubscriptionPlan.fromJson({
        'code': 'MONTHLY_25K',
        'nameAr': 'اشتراك شهري',
        'nameEn': 'Monthly subscription',
        'priceIqd': 25000,
        'durationDays': 30,
      });

      expect(plan.nameFor('ar'), 'اشتراك شهري');
      expect(plan.nameFor('en'), 'Monthly subscription');
      // Arabic is the primary language and the fallback for anything else.
      expect(plan.nameFor('ku'), 'اشتراك شهري');
    });
  });

  group('DriverSubscription.daysRemainingAt', () {
    DriverSubscription at(String expires) => DriverSubscription.fromJson({
          'id': 's1',
          'planCode': 'MONTHLY_25K',
          'status': 'ACTIVE',
          'chargedIqd': 25000,
          'startedAt': '2026-03-01T00:00:00.000Z',
          'expiresAt': expires,
          'transactionId': 't1',
        });

    final now = DateTime.parse('2026-03-10T00:00:00.000Z');

    test('counts whole days left', () {
      expect(at('2026-03-20T00:00:00.000Z').daysRemainingAt(now), 10);
    });

    test('rounds DOWN, so a part-day never reads as a whole one', () {
      // Expiring in 23 hours is "0 days left", not "1". The safe direction:
      // telling a driver they have a day they do not have is the error that
      // costs them a shift.
      expect(at('2026-03-10T23:00:00.000Z').daysRemainingAt(now), 0);
    });

    test('floors at zero for an already-expired period', () {
      // Never negative. `AlySubscriptionCard` treats <= 0 as expired, and a
      // negative would render as "-3 days left".
      expect(at('2026-03-01T00:00:00.000Z').daysRemainingAt(now), 0);
    });

    test('reads a null transaction, which means a granted free period', () {
      final granted = DriverSubscription.fromJson({
        'id': 's2',
        'planCode': 'MONTHLY_25K',
        'status': 'ACTIVE',
        'chargedIqd': 0,
        'startedAt': '2026-03-01T00:00:00.000Z',
        'expiresAt': '2026-03-31T00:00:00.000Z',
        'transactionId': null,
      });

      expect(granted.transactionId, isNull);
      expect(granted.chargedIqd, IqdAmount.zero);
    });
  });

  group('blocker copy', () {
    const ar = ArabicStrings();
    const en = EnglishStrings();

    test('every known code has a title and an action in both languages', () {
      const codes = [
        'ACCOUNT_DISABLED',
        'NOT_A_DRIVER',
        'APPROVAL_PENDING',
        'APPROVAL_REJECTED',
        'SUSPENDED',
        'DOCUMENTS_INCOMPLETE',
        'SUBSCRIPTION_REQUIRED',
      ];

      for (final code in codes) {
        for (final strings in [ar, en]) {
          expect(strings.blockerTitle(code), isNotEmpty, reason: code);
          expect(strings.blockerAction(code), isNotEmpty, reason: code);
          // The action must tell the driver what to DO, never restate the
          // title. Identical text is the failure mode this guards.
          expect(strings.blockerAction(code), isNot(strings.blockerTitle(code)));
        }
      }
    });

    test('an unknown code still produces a usable row', () {
      // The server ships weekly and the Play Store review does not, so a driver
      // WILL receive a code their build has never seen. Throwing puts a red
      // screen in front of someone trying to work; filtering leaves a toggle
      // that does nothing and an empty list explaining why.
      expect(ar.blockerTitle('SOMETHING_NEW_2027'), isNotEmpty);
      expect(en.blockerAction('SOMETHING_NEW_2027'), isNotEmpty);
      expect(en.blockerActionLabel('SOMETHING_NEW_2027'), en.contactSupport);
    });

    test('a pending review offers no button, because there is nothing to press', () {
      // A button implying the driver can hurry the review along would be a lie.
      expect(ar.blockerActionLabel('APPROVAL_PENDING'), isNull);
      expect(en.blockerActionLabel('APPROVAL_PENDING'), isNull);
    });

    test('a lapsed subscription offers renewal, not support', () {
      expect(ar.blockerActionLabel('SUBSCRIPTION_REQUIRED'), ar.renewSubscription);
      expect(en.blockerActionLabel('SUBSCRIPTION_REQUIRED'), en.renewSubscription);
    });
  });

  group('Arabic day agreement', () {
    const ar = ArabicStrings();

    test('uses singular, dual, and both plurals', () {
      // Arabic counts in four shapes, not two. `$n أيام` for every value reads
      // as broken Arabic in exactly the way `1 days` reads in English - and
      // this sits on the line telling a driver whether they can work tomorrow.
      expect(ar.subscriptionRemaining(1), contains('يوم واحد'));
      expect(ar.subscriptionRemaining(2), contains('يومان'));
      expect(ar.subscriptionRemaining(5), contains('5 أيام'));
      expect(ar.subscriptionRemaining(15), contains('15 يوماً'));
    });

    test('English pluralises too', () {
      const en = EnglishStrings();
      expect(en.subscriptionRemaining(1), '1 day left');
      expect(en.subscriptionRemaining(5), '5 days left');
    });
  });
}
