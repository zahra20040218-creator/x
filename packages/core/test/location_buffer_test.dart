import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:rideapp_core/src/location/location_buffer.dart';

/// CLAUDE.md §5.3 - "Buffer locations locally when offline and flush on
/// reconnect."
///
/// The failure this prevents is a driver crossing 20 minutes of dead coverage
/// and every fix being lost. That cannot be reproduced on a simulator, so the
/// buffering rules are tested here as pure logic instead.
void main() {
  LocationSample sampleAt(int second) => LocationSample(
        lat: 33.3061,
        lng: 44.4213,
        recordedAt: DateTime.utc(2026, 1, 1, 12, 0, second),
      );

  group('LocationBuffer', () {
    test('starts empty', () async {
      final buffer = LocationBuffer(storage: InMemoryBufferStorage());
      await buffer.load();
      expect(buffer.isEmpty, isTrue);
      expect(buffer.length, 0);
    });

    test('accumulates samples while offline', () async {
      final buffer = LocationBuffer(storage: InMemoryBufferStorage());
      for (var i = 0; i < 10; i++) {
        await buffer.add(sampleAt(i));
      }
      expect(buffer.length, 10);
    });

    test('survives a restart', () async {
      final storage = InMemoryBufferStorage();
      final first = LocationBuffer(storage: storage);
      await first.add(sampleAt(1));
      await first.add(sampleAt(2));

      // A cold start after Android killed the process.
      final second = LocationBuffer(storage: storage);
      await second.load();

      expect(second.length, 2);
      expect((await second.peek(1)).first.recordedAt.second, 1);
    });

    // An unbounded buffer across a long dead zone is an OOM kill - and Android
    // killing the app is exactly the outcome §5.3 exists to prevent.
    test('is bounded, dropping the OLDEST samples first', () async {
      final buffer = LocationBuffer(storage: InMemoryBufferStorage(), maxSamples: 5);

      for (var i = 0; i < 10; i++) {
        await buffer.add(sampleAt(i));
      }

      expect(buffer.length, 5);
      final kept = await buffer.peek(5);
      // 0-4 were dropped; the NEWEST fix is the one the rider's map needs.
      expect(kept.first.recordedAt.second, 5);
      expect(kept.last.recordedAt.second, 9);
    });

    group('peek and confirm', () {
      test('peek does not remove, so a failed upload loses nothing', () async {
        final buffer = LocationBuffer(storage: InMemoryBufferStorage());
        await buffer.add(sampleAt(1));
        await buffer.add(sampleAt(2));

        final batch = await buffer.peek(2);
        expect(batch.length, 2);

        // The upload failed; nothing was confirmed.
        expect(buffer.length, 2);
      });

      test('confirm removes exactly what the server accepted', () async {
        final buffer = LocationBuffer(storage: InMemoryBufferStorage());
        for (var i = 0; i < 5; i++) {
          await buffer.add(sampleAt(i));
        }

        await buffer.confirm(3);

        expect(buffer.length, 2);
        expect((await buffer.peek(2)).first.recordedAt.second, 3);
      });

      test('a partial upload leaves the rest buffered', () async {
        final buffer = LocationBuffer(storage: InMemoryBufferStorage());
        for (var i = 0; i < 10; i++) {
          await buffer.add(sampleAt(i));
        }

        // The server accepted 4 of the 10 offered.
        await buffer.confirm(4);
        expect(buffer.length, 6);
      });

      test('confirm never removes more than exists', () async {
        final buffer = LocationBuffer(storage: InMemoryBufferStorage());
        await buffer.add(sampleAt(1));

        await buffer.confirm(99);
        expect(buffer.length, 0);
      });

      test('confirm(0) is a no-op', () async {
        final buffer = LocationBuffer(storage: InMemoryBufferStorage());
        await buffer.add(sampleAt(1));
        await buffer.confirm(0);
        expect(buffer.length, 1);
      });

      test('preserves FIFO order across a flush cycle', () async {
        final buffer = LocationBuffer(storage: InMemoryBufferStorage());
        for (var i = 0; i < 6; i++) {
          await buffer.add(sampleAt(i));
        }

        final first = await buffer.peek(3);
        expect(first.map((s) => s.recordedAt.second), [0, 1, 2]);
        await buffer.confirm(3);

        final second = await buffer.peek(3);
        expect(second.map((s) => s.recordedAt.second), [3, 4, 5]);
      });
    });

    // Losing some history is survivable. Refusing to let the driver go online
    // is not.
    test('recovers from a corrupted buffer instead of refusing to start', () async {
      final storage = InMemoryBufferStorage();
      await storage.write('this is not json');

      final buffer = LocationBuffer(storage: storage);
      await buffer.load();

      expect(buffer.isEmpty, isTrue);
      await buffer.add(sampleAt(1));
      expect(buffer.length, 1);
    });

    test('clear empties both memory and storage', () async {
      final storage = InMemoryBufferStorage();
      final buffer = LocationBuffer(storage: storage);
      await buffer.add(sampleAt(1));

      await buffer.clear();

      expect(buffer.isEmpty, isTrue);
      expect(await storage.read(), isNull);
    });

    // The full round trip the driver app performs on reconnect.
    test('a 20-minute offline stretch flushes completely on reconnect', () async {
      final buffer = LocationBuffer(storage: InMemoryBufferStorage());

      // One fix every 5 seconds for 20 minutes.
      for (var i = 0; i < 240; i++) {
        await buffer.add(sampleAt(i));
      }
      expect(buffer.length, 240);

      // Flushed in batches of 200, the cap the API accepts.
      var uploaded = 0;
      while (!buffer.isEmpty) {
        final batch = await buffer.peek(200);
        uploaded += batch.length;
        await buffer.confirm(batch.length);
      }

      expect(uploaded, 240);
      expect(buffer.isEmpty, isTrue);
    });
  });
}
