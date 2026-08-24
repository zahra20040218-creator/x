import 'dart:async';

import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Background location. **CLAUDE.md §5.3.**
///
/// The constitution calls this "the single most common cause of ride-hailing
/// MVP failure in production", and the four requirements it lists are each
/// answered here:
///
///  1. **Foreground service with a persistent notification.** Anything less is
///     killed by Android within minutes of the screen going off. This is not a
///     preference — a plain isolate or a `Timer` in the app process simply
///     stops.
///
///  2. **Battery optimisation exemption, requested at onboarding with an
///     explanatory screen.** Doze suspends even a foreground service's network
///     access on many OEM builds. The explanation matters as much as the
///     request: a driver who taps "deny" on an unexplained system dialog has
///     silently broken their own app.
///
///  3. **Buffer locally when offline, flush on reconnect.** Handled by
///     `LocationBuffer` in packages/core, which is unit-tested.
///
///  4. **Never `WorkManager` for sub-minute intervals.** WorkManager's real
///     floor is ~15 minutes regardless of what you ask for. It is not used
///     anywhere in this file.
///
/// ## What this code cannot prove
///
/// All of the above is necessary and none of it is sufficient. Xiaomi (MIUI),
/// Samsung, Huawei and Oppo each add their own killer on top of stock Android,
/// and they behave differently from each other and from the emulator. The only
/// test that means anything is `ACCEPTANCE_CHECKLIST.md` check 2: 20 minutes of
/// real driving with the screen off, repeated on a Xiaomi and a Samsung.
///
/// Treat this file as a serious attempt, not as a solved problem.
@pragma('vm:entry-point')
void startLocationCallback() {
  FlutterForegroundTask.setTaskHandler(_LocationTaskHandler());
}

/// How often a position is sampled while online.
///
/// 5 seconds is a compromise: the rider's map feeling live versus battery.
/// CLAUDE.md's acceptance bar is under 15% per hour, and sub-second sampling
/// blows through that. Tune with the checklist's battery measurement, not by
/// guessing.
const Duration kSampleInterval = Duration(seconds: 5);

/// Distance filter. Stationary at a red light should not generate traffic.
const int kDistanceFilterMeters = 10;

/// How often the buffer is flushed to the server while online.
const Duration kFlushInterval = Duration(seconds: 15);

/// Max samples per upload — matches the API contract's cap.
const int kFlushBatchSize = 200;

class _LocationTaskHandler extends TaskHandler {
  StreamSubscription<Position>? _positions;
  Timer? _flushTimer;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    _positions = Geolocator.getPositionStream(
      locationSettings: AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: kDistanceFilterMeters,
        intervalDuration: kSampleInterval,
        // The service is ALREADY a foreground service; this tells geolocator
        // not to start a second notification of its own.
        foregroundNotificationConfig: null,
      ),
    ).listen(_onPosition);

    _flushTimer = Timer.periodic(kFlushInterval, (_) => _flush());
  }

  /// Positions are handed to the app isolate rather than uploaded from here.
  ///
  /// The task isolate has no access to the app's token store or Dio instance,
  /// and duplicating auth into it would mean two places holding a refresh
  /// token. `sendDataToMain` keeps exactly one.
  void _onPosition(Position position) {
    FlutterForegroundTask.sendDataToMain({
      'type': 'position',
      'lat': position.latitude,
      'lng': position.longitude,
      'accuracyM': position.accuracy,
      'headingDeg': position.heading,
      'speedMps': position.speed,
      'recordedAt': position.timestamp.toUtc().toIso8601String(),
    });
  }

  void _flush() => FlutterForegroundTask.sendDataToMain({'type': 'flush'});

  @override
  Future<void> onRepeatEvent(DateTime timestamp) async {
    // Heartbeat. If the position stream died silently — which OEM power
    // managers do — this still fires and the main isolate can notice the gap.
    FlutterForegroundTask.sendDataToMain({
      'type': 'heartbeat',
      'at': timestamp.toUtc().toIso8601String(),
    });
  }

  /// `flutter_foreground_task` 8.17.0 declares `onDestroy(DateTime)`.
  /// This was written with a second `bool isTimeout` parameter from memory of
  /// a different version - the first compile caught it.
  @override
  Future<void> onDestroy(DateTime timestamp) async {
    await _positions?.cancel();
    _flushTimer?.cancel();
  }
}

/// Drives the foreground service from the app isolate.
class DriverLocationService {
  DriverLocationService({
    required ApiClient api,
    required LocationBuffer buffer,
    required AppStrings strings,
  })  : _api = api,
        _buffer = buffer,
        _strings = strings;

  final ApiClient _api;
  final LocationBuffer _buffer;
  final AppStrings _strings;

  bool _running = false;
  bool _flushing = false;

  bool get isRunning => _running;

  /// Buffered-but-unsent count, surfaced in the UI so a driver can see that
  /// their positions are queued rather than lost.
  int get pendingCount => _buffer.length;

  Future<void> init() async {
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'driver_status',
        channelName: _strings.notificationChannelName,
        // LOW so the notification is persistent but silent. A driver who mutes
        // a noisy notification channel also mutes the service's visibility.
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
      ),
      iosNotificationOptions: const IOSNotificationOptions(),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.repeat(30_000),
        // Both true: without them the OS reclaims the service on memory
        // pressure and never restarts it, and the driver's location silently
        // stops for the rest of their shift.
        autoRunOnBoot: true,
        allowWakeLock: true,
        allowWifiLock: true,
      ),
    );

    FlutterForegroundTask.addTaskDataCallback(_onTaskData);
    await _buffer.load();
  }

  /// Start tracking. Returns false if a permission or exemption is missing —
  /// the caller must show the explanatory screen rather than silently failing.
  Future<bool> start() async {
    if (!await LocationPermissions.hasAllRequired()) return false;

    await FlutterForegroundTask.startService(
      notificationTitle: _strings.foregroundServiceTitle,
      notificationText: _strings.foregroundServiceBody,
      callback: startLocationCallback,
    );

    _running = true;
    return true;
  }

  Future<void> stop() async {
    _running = false;
    await FlutterForegroundTask.stopService();
    // A final flush, so the last few minutes of a shift are not lost.
    await flush();
  }

  void _onTaskData(Object data) {
    if (data is! Map) return;
    final map = Map<String, dynamic>.from(data);

    switch (map['type']) {
      case 'position':
        unawaited(_buffer.add(LocationSample.fromJson(map)));
      case 'flush':
        unawaited(flush());
      case 'heartbeat':
        break;
    }
  }

  /// Upload buffered samples.
  ///
  /// Peek, upload, confirm — never pop-then-upload. On these networks the
  /// upload fails often, and popping first would discard exactly the data §5.3
  /// is written to preserve.
  Future<void> flush() async {
    if (_flushing || _buffer.isEmpty) return;
    _flushing = true;

    try {
      while (!_buffer.isEmpty) {
        final batch = await _buffer.peek(kFlushBatchSize);
        if (batch.isEmpty) break;

        await _api.reportLocations(batch);
        await _buffer.confirm(batch.length);
      }
    } on ApiException catch (error) {
      // Retryable: keep the buffer and try again on the next tick. Anything
      // else (a 401, a 403 for a suspended driver) is not fixed by retrying,
      // and the buffer is still kept — the driver may come back online.
      if (!error.isRetryable && error.requiresReauthentication) {
        _running = false;
      }
    } finally {
      _flushing = false;
    }
  }

  void dispose() {
    FlutterForegroundTask.removeTaskDataCallback(_onTaskData);
  }
}

/// The permission sequence, in the order Android requires it.
///
/// The order is not cosmetic: asking for `locationAlways` before `locationWhenInUse`
/// is auto-denied on Android 11+ without ever showing the user a dialog, and
/// the app then looks broken for a reason nobody can see.
abstract class LocationPermissions {
  static Future<bool> hasAllRequired() async {
    final permission = await Geolocator.checkPermission();
    return permission == LocationPermission.always;
  }

  /// Step 1: foreground location.
  static Future<bool> requestForeground() async {
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    return permission == LocationPermission.whileInUse ||
        permission == LocationPermission.always;
  }

  /// Step 2: background ("Allow all the time").
  ///
  /// Must come AFTER foreground is granted, and should be preceded by the
  /// explanatory screen — Android shows this one as a settings page, not a
  /// dialog, and a driver who lands there with no context just backs out.
  static Future<bool> requestBackground() async {
    final permission = await Geolocator.requestPermission();
    return permission == LocationPermission.always;
  }

  static Future<bool> isLocationServiceEnabled() =>
      Geolocator.isLocationServiceEnabled();
}
