import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// One event from the server's realtime channel.
class RealtimeEvent {
  const RealtimeEvent({required this.type, required this.payload});

  factory RealtimeEvent.fromJson(Map<String, dynamic> json) => RealtimeEvent(
        type: json['type'] as String? ?? '',
        payload: (json['payload'] as Map<String, dynamic>?) ?? const {},
      );

  final String type;
  final Map<String, dynamic> payload;
}

/// The server's realtime channel.
///
/// ## Why this is shared rather than written twice
///
/// The rider app had a socket inline in one screen; the driver app had none at
/// all and polled `GET /driver/offers/current` every five seconds. Offers
/// expire in fifteen, so a third of the time a driver has to decide was spent
/// before the offer reached their screen. `CLAUDE.md` §1 makes the duplicated
/// version of this a defect, and the driver needed the better half of it.
///
/// ## Reconnection is the point
///
/// A dropped socket is the normal case on Iraqi mobile networks, not the
/// exception. The sequence after a drop has to be the whole of:
///
///     disconnect → back off → reconnect → authenticate → resubscribe → resync
///
/// The first four are here. The fifth is the caller's: this class cannot know
/// what "current state" means for a given screen, so [onReconnect] fires after
/// every successful re-authentication and the screen refetches. Without that
/// step a client that was disconnected for a minute reconnects and quietly
/// keeps showing state from before the gap.
///
/// Backoff is exponential and capped. A flat retry hammers a server that is
/// already struggling, which is precisely when every client drops at once.
class RealtimeClient {
  RealtimeClient({
    required this.url,
    required this.tokenProvider,
    this.onReconnect,
    this.onAuthRejected,
    Duration initialBackoff = const Duration(seconds: 1),
    Duration maxBackoff = const Duration(seconds: 30),
  })  : _initialBackoff = initialBackoff,
        _maxBackoff = maxBackoff;

  final String url;

  /// Read fresh on every connect: an access token expires, and reconnecting
  /// with the one captured at construction fails exactly when the network has
  /// been down long enough to matter.
  final Future<String?> Function() tokenProvider;

  /// Called after a reconnect that authenticated, so the caller can resync.
  final void Function()? onReconnect;

  /// The server refused the token (close code 4401).
  ///
  /// Retrying is pointless: an expired or revoked token does not become valid
  /// by waiting, and a signed-out app that keeps reconnecting is a client
  /// hammering a server it has no business talking to. The caller refreshes the
  /// session and calls [connect] again, or routes to sign-in.
  final void Function()? onAuthRejected;

  final Duration _initialBackoff;
  final Duration _maxBackoff;

  /// The server's code for "this token is not valid". See RealtimeGateway.
  static const _closeUnauthenticated = 4401;

  final _events = StreamController<RealtimeEvent>.broadcast();
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _retry;
  Duration _backoff = const Duration(seconds: 1);
  bool _closed = false;
  bool _hasConnectedOnce = false;

  /// Events from the server. Never closes until [dispose].
  Stream<RealtimeEvent> get events => _events.stream;

  bool get isConnected => _channel != null;

  Future<void> connect() async {
    if (_closed) return;

    final token = await tokenProvider();
    if (token == null) {
      // Not signed in. Not an error, and not worth retrying against.
      return;
    }

    try {
      final channel = WebSocketChannel.connect(Uri.parse(url));
      _channel = channel;

      // The token goes in the first frame: a WebSocket handshake cannot carry
      // an Authorization header. The server closes the socket with 4401 if
      // this does not arrive.
      channel.sink.add(jsonEncode({'type': 'auth', 'token': token}));

      _subscription = channel.stream.listen(
        _onFrame,
        onError: (Object _) => _handleDisconnect(),
        onDone: _handleDisconnect,
        cancelOnError: true,
      );
    } on Exception {
      _scheduleReconnect();
    }
  }

  void _onFrame(dynamic raw) {
    if (raw is! String) return;

    final Map<String, dynamic> decoded;
    try {
      decoded = jsonDecode(raw) as Map<String, dynamic>;
    } on FormatException {
      // A frame the server should not have sent. Dropping it beats taking the
      // connection down with it.
      return;
    }

    if (decoded['type'] == 'ready') {
      // Authenticated and subscribed. Only now is the connection healthy, so
      // only now does the backoff reset - resetting it on `connect` would turn
      // a server that accepts and immediately closes into a tight loop.
      _backoff = _initialBackoff;

      // Not on the first connect: the caller has just loaded its state.
      if (_hasConnectedOnce) onReconnect?.call();
      _hasConnectedOnce = true;
      return;
    }

    _events.add(RealtimeEvent.fromJson(decoded));
  }

  /// Decide whether this disconnect is worth retrying.
  void _handleDisconnect() {
    // `closeCode` is only readable once the socket has actually closed, which
    // is why this is checked here rather than in the error handler.
    if (_channel?.closeCode == _closeUnauthenticated) {
      _teardownSocket();
      onAuthRejected?.call();
      return;
    }
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed || _retry != null) return;

    _teardownSocket();

    final wait = _backoff;
    _retry = Timer(wait, () {
      _retry = null;
      unawaited(connect());
    });

    // Doubled for next time, capped. Reset only on a successful `ready`.
    final next = _backoff * 2;
    _backoff = next > _maxBackoff ? _maxBackoff : next;
  }

  void _teardownSocket() {
    unawaited(_subscription?.cancel());
    _subscription = null;
    unawaited(_channel?.sink.close());
    _channel = null;
  }

  /// Stop, and stay stopped.
  Future<void> dispose() async {
    _closed = true;
    _retry?.cancel();
    _retry = null;
    _teardownSocket();
    await _events.close();
  }
}
