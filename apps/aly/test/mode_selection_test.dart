import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// How ALY decides which mode to show.
///
/// CLAUDE.md §1.1 makes this a SERVER decision, and it is the single most
/// consequential branch in the merged app: get it wrong and a working driver is
/// shown a passenger's screen, or a passenger is shown a driver's.
///
/// The rule under test is deliberately NOT "allowed ? driver : rider".
/// `allowed` is false for a driver whose subscription lapsed, whose documents
/// expired, or who was suspended - all of whom are still drivers, with a
/// problem to fix. Only `NOT_A_DRIVER` means "this account has no driver row",
/// which is the genuine passenger case.
///
/// The predicate is duplicated here rather than imported because `main.dart`
/// keeps it inside a private State class. If that ever diverges from this, the
/// test is the specification and main.dart is the bug.
bool showsDriverMode(Capabilities capabilities) =>
    !capabilities.driver.blockers.contains('NOT_A_DRIVER');

Capabilities caps({
  required bool allowed,
  required List<String> blockers,
}) =>
    Capabilities.fromJson({
      'userId': 'u1',
      'canRide': true,
      'driver': {
        'allowed': allowed,
        'blockers': blockers,
        'missingDocuments': <String>[],
        'expiredDocuments': <String>[],
        'rejectedDocuments': <String>[],
      },
    });

void main() {
  group('mode selection', () {
    test('a working driver gets Driver mode', () {
      expect(showsDriverMode(caps(allowed: true, blockers: [])), isTrue);
    });

    test('a plain passenger gets Rider mode', () {
      expect(
        showsDriverMode(caps(allowed: false, blockers: ['NOT_A_DRIVER'])),
        isFalse,
      );
    });

    test('a driver with a LAPSED SUBSCRIPTION stays in Driver mode', () {
      // The bug this test exists for: selecting on `allowed` would put this
      // driver on a passenger's "where to?" screen. They would have no way to
      // discover why they stopped receiving work, and no route to renewing.
      expect(
        showsDriverMode(caps(allowed: false, blockers: ['SUBSCRIPTION_REQUIRED'])),
        isTrue,
      );
    });

    test('a SUSPENDED driver stays in Driver mode, to be told they are suspended', () {
      expect(
        showsDriverMode(caps(allowed: false, blockers: ['SUSPENDED'])),
        isTrue,
      );
    });

    test('a driver with EXPIRED DOCUMENTS stays in Driver mode', () {
      expect(
        showsDriverMode(caps(allowed: false, blockers: ['DOCUMENTS_INCOMPLETE'])),
        isTrue,
      );
    });

    test('a driver awaiting APPROVAL stays in Driver mode', () {
      expect(
        showsDriverMode(caps(allowed: false, blockers: ['APPROVAL_PENDING'])),
        isTrue,
      );
    });

    test('a code this build has never seen does not demote a driver', () {
      // The server ships weekly and the Play Store review does not. An unknown
      // blocker must not be read as "not a driver".
      expect(
        showsDriverMode(caps(allowed: false, blockers: ['SOMETHING_NEW_2027'])),
        isTrue,
      );
    });

    test('NOT_A_DRIVER wins even when other blockers are present', () {
      // A disabled account reports ACCOUNT_DISABLED and nothing else, but a
      // defensive read: if the server ever sends NOT_A_DRIVER alongside
      // anything, there is no driver row and Driver mode has nothing to show.
      expect(
        showsDriverMode(
          caps(allowed: false, blockers: ['ACCOUNT_DISABLED', 'NOT_A_DRIVER']),
        ),
        isFalse,
      );
    });
  });

  group('what the blocked-driver screen must be able to say', () {
    const ar = ArabicStrings();

    test('every blocker that keeps a driver in Driver mode has actionable copy', () {
      // If Driver mode is shown to a blocked driver, the reason must render.
      // A blocker with no sentence would be a blank screen where their
      // livelihood used to be.
      for (final code in [
        'SUBSCRIPTION_REQUIRED',
        'SUSPENDED',
        'DOCUMENTS_INCOMPLETE',
        'APPROVAL_PENDING',
        'APPROVAL_REJECTED',
        'ACCOUNT_DISABLED',
      ]) {
        expect(ar.blockerTitle(code), isNotEmpty, reason: code);
        expect(ar.blockerAction(code), isNotEmpty, reason: code);
      }
    });

    test('only the subscription blocker offers an in-app route', () {
      // Everything else routes to support, because nothing in the app can fix
      // a suspension or a rejected licence.
      expect(ar.blockerActionLabel('SUBSCRIPTION_REQUIRED'), ar.renewSubscription);
      expect(ar.blockerActionLabel('SUSPENDED'), ar.contactSupport);
      expect(ar.blockerActionLabel('APPROVAL_PENDING'), isNull);
    });
  });
}
