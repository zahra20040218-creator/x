import 'dart:async';
import 'dart:convert';

import 'package:rideapp_core/src/models/models.dart';

/// Offline buffer for driver positions. CLAUDE.md §5.3:
///
///   "Buffer locations locally when offline and flush on reconnect."
///
/// This is pure Dart with a storage port, so the buffering and eviction rules
/// are unit-testable without a device — which matters, because the failure this
/// prevents (a driver drives 20 minutes through dead coverage and every fix is
/// lost) cannot be reproduced on a simulator either.
///
/// Two rules that are easy to get wrong:
///
///  * **Bounded.** An unbounded buffer on a two-hour dead zone is an OOM kill,
///    and Android killing the app is precisely the outcome §5.3 is about. When
///    full, the OLDEST samples are dropped: the newest position is the one the
///    rider's map needs.
///
///  * **Drained only on confirmed upload.** Samples are removed after the
///    server accepts them, never before. A failed flush leaves the buffer
///    intact for the next attempt.
abstract class BufferStorage {
  Future<String?> read();
  Future<void> write(String contents);
  Future<void> clear();
}

/// In-memory storage, for tests. Production wires this to a file in the app's
/// private directory — not SharedPreferences, which is not built for a
/// thousand-element list rewritten every few seconds.
class InMemoryBufferStorage implements BufferStorage {
  String? _contents;

  @override
  Future<String?> read() async => _contents;

  @override
  Future<void> write(String contents) async => _contents = contents;

  @override
  Future<void> clear() async => _contents = null;
}

class LocationBuffer {
  LocationBuffer({
    required BufferStorage storage,
    this.maxSamples = 2000,
  }) : _storage = storage;

  /// ~2.8 hours at one sample every 5 seconds. Past that, a driver has bigger
  /// problems than a gap in their history, and the memory matters more.
  final int maxSamples;

  final BufferStorage _storage;
  final List<LocationSample> _samples = [];
  bool _loaded = false;

  /// Serialises writes. Without it a flush and an add can interleave and the
  /// file ends up holding a partially-written list.
  Future<void> _pending = Future<void>.value();

  int get length => _samples.length;
  bool get isEmpty => _samples.isEmpty;

  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;

    final raw = await _storage.read();
    if (raw == null || raw.isEmpty) return;

    try {
      final decoded = jsonDecode(raw) as List<dynamic>;
      _samples
        ..clear()
        ..addAll(
          decoded
              .whereType<Map<String, dynamic>>()
              .map(LocationSample.fromJson),
        );
    } on FormatException {
      // A corrupted buffer must not stop the driver going online. Losing some
      // history is survivable; refusing to start is not.
      await _storage.clear();
    }
  }

  Future<void> add(LocationSample sample) async {
    await load();
    _samples.add(sample);

    // Drop from the FRONT: the newest fix is the one that matters.
    if (_samples.length > maxSamples) {
      _samples.removeRange(0, _samples.length - maxSamples);
    }

    await _persist();
  }

  /// Take up to [limit] of the oldest samples WITHOUT removing them.
  ///
  /// Removal happens in [confirm], after the server accepted them. Popping here
  /// would lose the batch whenever the upload failed - which, on the networks
  /// this is written for, is most of the time.
  Future<List<LocationSample>> peek(int limit) async {
    await load();
    return _samples.take(limit).toList();
  }

  /// Remove samples the server confirmed.
  Future<void> confirm(int count) async {
    await load();
    if (count <= 0) return;
    _samples.removeRange(0, count.clamp(0, _samples.length));
    await _persist();
  }

  Future<void> clear() async {
    _samples.clear();
    await _storage.clear();
  }

  Future<void> _persist() {
    _pending = _pending.then((_) async {
      await _storage.write(
        jsonEncode(_samples.map((s) => s.toJson()).toList()),
      );
    });
    return _pending;
  }
}
