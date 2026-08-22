import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:rideapp_driver/location/location_service.dart';

/// CLAUDE.md §5.3, and what can honestly be asserted about it without a device.
///
/// ## Read this before trusting a green run
///
/// These tests cover the parts of the location path that are pure logic: the
/// sampling constants, and the buffer's flush cycle. They say NOTHING about the
/// thing that actually breaks in production — whether Android lets the service
/// keep running once the screen is off.
///
/// That cannot be tested here, or on an emulator, or in CI. Xiaomi (MIUI),
/// Samsung, Huawei and Oppo each add their own process killer on top of stock
/// Android and behave differently from each other. The only test that means
/// anything is `ACCEPTANCE_CHECKLIST.md` check 2: twenty minutes of real
/// driving with the screen off, repeated on a Xiaomi and a Samsung.
///
/// A green run here means the code is internally consistent. It does not mean
/// background location works.
void main() {
  group('sampling configuration', () {
    // Sub-second sampling blows through the checklist's 15%-per-hour battery
    // bar; minute-scale sampling makes the rider's map feel dead.
    test('samples often enough to feel live and rarely enough to be affordable', () {
      expect(kSampleInterval.inSeconds, greaterThanOrEqualTo(3));
      expect(kSampleInterval.inSeconds, lessThanOrEqualTo(10));
    });

    test('has a distance filter so a driver at a red light sends nothing', () {
      expect(kDistanceFilterMeters, greaterThan(0));
    });

    test('flushes more often than the server considers a driver stale', () {
      // The server evicts a driver after DRIVER_PRESENCE_TTL_SECONDS (60s) of
      // silence. Flushing less often than that would let an online driver be
      // swept off the map mid-shift.
      expect(kFlushInterval.inSeconds, lessThan(60));
    });

    test('batches within the API contract cap', () {
      expect(kFlushBatchSize, lessThanOrEqualTo(200));
    });
  });

  group('offline buffering', () {
    LocationSample sampleAt(int second) => LocationSample(
          lat: 33.3061,
          lng: 44.4213,
          recordedAt: DateTime.utc(2026, 1, 1, 12, 0, second),
        );

    // The scenario §5.3 is written for: a driver crosses a dead zone and every
    // fix must survive to be uploaded on reconnect.
    test('nothing is lost across a coverage gap', () async {
      final buffer = LocationBuffer(storage: InMemoryBufferStorage());

      for (var i = 0; i < 120; i++) {
        await buffer.add(sampleAt(i));
      }

      // First flush attempt fails - the peek happened, the confirm did not.
      final attempted = await buffer.peek(kFlushBatchSize);
      expect(attempted.length, 120);
      expect(buffer.length, 120, reason: 'a failed upload must lose nothing');

      // Reconnected: the same samples are still there and now confirm.
      final retried = await buffer.peek(kFlushBatchSize);
      await buffer.confirm(retried.length);
      expect(buffer.isEmpty, isTrue);
    });

    test('the newest fix survives when the buffer overflows', () async {
      final buffer = LocationBuffer(storage: InMemoryBufferStorage(), maxSamples: 10);

      for (var i = 0; i < 50; i++) {
        await buffer.add(sampleAt(i));
      }

      final kept = await buffer.peek(10);
      // The rider's map needs where the driver IS, not where they were.
      expect(kept.last.recordedAt.second, 49);
    });
  });
}
