import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_aly/screens/track_ride_screen.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// What the rider's tracking screen offers, per ride status.
///
/// These were `if` conditions inside a `build` method, which is why none of
/// them had a test: reaching "the ride was cancelled by the driver while the
/// rider watched" needs a server, a driver and a race. As a value it needs an
/// enum.
///
/// The rule that matters most here is the cancel button. CLAUDE.md §4 permits
/// `CANCELLED_IN_TRIP` **to an admin only** — a rider must not be offered a
/// control that the state machine will refuse, and worse, must not be offered
/// one that would strand a driver mid-journey.
void main() {
  group('TrackRideView — cancelling', () {
    test('is offered while a driver is being found', () {
      expect(TrackRideView.of(RideStatus.requested).canCancel, isTrue);
      expect(TrackRideView.of(RideStatus.offered).canCancel, isTrue);
    });

    test('is offered while the driver is on the way, and once they arrive', () {
      expect(TrackRideView.of(RideStatus.accepted).canCancel, isTrue);
      expect(TrackRideView.of(RideStatus.driverArrived).canCancel, isTrue);
    });

    test('is NOT offered once the trip is under way — §4, admin only', () {
      expect(
        TrackRideView.of(RideStatus.inProgress).canCancel,
        isFalse,
        reason: 'CANCELLED_IN_TRIP is an admin transition; offering it to the '
            'rider means a control the state machine refuses, or a driver '
            'abandoned mid-journey',
      );
    });

    test('is not offered on any terminal status', () {
      for (final status in [
        RideStatus.completed,
        RideStatus.cancelledByRider,
        RideStatus.cancelledByDriver,
        RideStatus.cancelledInTrip,
        RideStatus.expired,
        RideStatus.noDriversFound,
      ]) {
        expect(
          TrackRideView.of(status).canCancel,
          isFalse,
          reason: 'nothing left to cancel in $status',
        );
      }
    });
  });

  group('TrackRideView — what the screen shows', () {
    test('searching, only while no driver has taken it', () {
      expect(TrackRideView.of(RideStatus.requested).isSearching, isTrue);
      expect(TrackRideView.of(RideStatus.offered).isSearching, isTrue);
      expect(TrackRideView.of(RideStatus.accepted).isSearching, isFalse);
    });

    test('the timeline appears once a driver has accepted, not before', () {
      // Before acceptance there are no timestamps to draw, and an empty
      // timeline reads as a stalled one.
      expect(TrackRideView.of(RideStatus.requested).showsTimeline, isFalse);
      expect(TrackRideView.of(RideStatus.offered).showsTimeline, isFalse);
      expect(TrackRideView.of(RideStatus.accepted).showsTimeline, isTrue);
      expect(TrackRideView.of(RideStatus.inProgress).showsTimeline, isTrue);
      expect(TrackRideView.of(RideStatus.completed).showsTimeline, isTrue);
    });

    test('rating is offered only after a completed ride', () {
      expect(TrackRideView.of(RideStatus.completed).canRate, isTrue);
      expect(TrackRideView.of(RideStatus.inProgress).canRate, isFalse);
      // A cancelled ride has no service to rate, and asking anyway reads as
      // the app not knowing what happened.
      expect(TrackRideView.of(RideStatus.cancelledByDriver).canRate, isFalse);
      expect(TrackRideView.of(RideStatus.cancelledByRider).canRate, isFalse);
    });

    test('"no drivers found" is called out, because it is not an error', () {
      expect(TrackRideView.of(RideStatus.noDriversFound).noDriversFound, isTrue);
      expect(TrackRideView.of(RideStatus.requested).noDriversFound, isFalse);
    });

    test('every status produces a view — a new one must not crash the screen', () {
      for (final status in RideStatus.values) {
        expect(() => TrackRideView.of(status), returnsNormally);
      }
    });
  });

  group('rating a ride twice', () {
    ApiException problem(ApiProblem problem) =>
        ApiException(problem: problem, status: 409);

    test('a 409 counts as submitted: the rating already exists', () {
      // The rider tapped submit, lost signal, tapped again. From where they
      // are sitting the rating went through — because it did.
      expect(ratingCountsAsSubmitted(problem(ApiProblem.conflict)), isTrue);
    });

    test('a network failure does NOT count, so the rider can retry', () {
      expect(ratingCountsAsSubmitted(problem(ApiProblem.network)), isFalse);
    });

    test('an expired session does not count either', () {
      expect(ratingCountsAsSubmitted(problem(ApiProblem.unauthorized)), isFalse);
    });
  });
}
