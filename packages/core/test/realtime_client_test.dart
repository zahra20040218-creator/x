import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The realtime client, against a real WebSocket server.
///
/// A mocked socket would prove the class calls the methods it calls. What
/// matters here is what happens when a connection actually drops, which needs a
/// server that can actually drop it.
///
/// The driver app had no socket at all and polled every five seconds against a
/// fifteen-second offer expiry. Reconnection is the part that decides whether
/// replacing that poll is an improvement or a regression: a client that drops
/// once and never comes back is strictly worse than one that polls.

class _TestServer {
  _TestServer(this._server) {
    _server.transform(WebSocketTransformer()).listen((socket) {
      final index = sockets.length;
      sockets.add(socket);
      socket.listen(
        (dynamic frame) {
          received.add(frame as String);
          if (rejectAuth) {
            socket.close(4401, 'invalid token');
            return;
          }
          // The server sends `ready` only after it has authenticated and
          // subscribed the connection.
          socket.add(jsonEncode({'type': 'ready'}));
          _readyFor(index).complete();
        },
        onError: (Object _) {},
        cancelOnError: true,
      );
    });
  }

  static Future<_TestServer> start() async =>
      _TestServer(await HttpServer.bind(InternetAddress.loopbackIPv4, 0));

  final HttpServer _server;
  final List<WebSocket> sockets = [];
  final List<String> received = [];
  final Map<int, Completer<void>> _ready = {};
  bool rejectAuth = false;

  Completer<void> _readyFor(int index) =>
      _ready.putIfAbsent(index, Completer<void>.new);

  /// Resolves once the connection at [index] has been sent `ready`.
  Future<void> readyAt(int index) => _readyFor(index).future;

  String get url => 'ws://127.0.0.1:${_server.port}';

  void send(int index, Object event) => sockets[index].add(jsonEncode(event));

  Future<void> dropAll() async {
    // 1001 "going away". 1006 is reserved for an ABNORMAL close that the
    // implementation reports itself; sending it explicitly is a protocol error
    // and throws.
    for (final socket in sockets) {
      await socket.close(1001);
    }
  }

  Future<void> stop() => _server.close(force: true);
}

void main() {
  late _TestServer server;

  setUp(() async => server = await _TestServer.start());
  tearDown(() async => server.stop());

  RealtimeClient clientFor({
    Future<String?> Function()? token,
    void Function()? onReconnect,
  }) =>
      RealtimeClient(
        url: server.url,
        tokenProvider: token ?? (() async => 'a-token'),
        onReconnect: onReconnect,
        initialBackoff: const Duration(milliseconds: 40),
        maxBackoff: const Duration(milliseconds: 160),
      );

  group('connecting', () {
    test('sends the token in the first frame', () async {
      final client = clientFor();
      addTearDown(client.dispose);

      await client.connect();
      await server.readyAt(0);

      // A WebSocket handshake cannot carry an Authorization header, so the
      // token has to be the first thing on the wire.
      expect(jsonDecode(server.received.first), {
        'type': 'auth',
        'token': 'a-token',
      });
    });

    test('does not connect when there is no session', () async {
      final client = clientFor(token: () async => null);
      addTearDown(client.dispose);

      await client.connect();
      await Future<void>.delayed(const Duration(milliseconds: 80));

      // Not signed in is not an error, and retrying against it is pointless.
      expect(server.sockets, isEmpty);
      expect(client.isConnected, isFalse);
    });

    test('reads the token fresh on every connect', () async {
      var issued = 0;
      final client = clientFor(token: () async => 'token-${issued++}');
      addTearDown(client.dispose);

      await client.connect();
      await server.readyAt(0);
      await server.dropAll();
      await server.readyAt(1);

      // An access token expires. Reconnecting with the one captured at
      // construction fails exactly when the network has been down long enough
      // for it to matter.
      expect(
        (jsonDecode(server.received[0]) as Map<String, dynamic>)['token'],
        'token-0',
      );
      expect(
        (jsonDecode(server.received[1]) as Map<String, dynamic>)['token'],
        'token-1',
      );
    });
  });

  group('events', () {
    test('delivers a ride offer to the listener', () async {
      final client = clientFor();
      addTearDown(client.dispose);
      final seen = <RealtimeEvent>[];
      client.events.listen(seen.add);

      await client.connect();
      await server.readyAt(0);
      server.send(0, {
        'type': 'ride.offer',
        'payload': {'rideId': 'ride-1', 'distanceM': 420},
      });
      await Future<void>.delayed(const Duration(milliseconds: 60));

      expect(seen.single.type, 'ride.offer');
      expect(seen.single.payload['rideId'], 'ride-1');
    });

    test('does not emit the ready frame as an event', () async {
      final client = clientFor();
      addTearDown(client.dispose);
      final seen = <RealtimeEvent>[];
      client.events.listen(seen.add);

      await client.connect();
      await server.readyAt(0);
      await Future<void>.delayed(const Duration(milliseconds: 60));

      // `ready` is protocol, not a ride event. A screen switching on
      // event.type should never see it.
      expect(seen, isEmpty);
    });

    test('a malformed frame does not take the connection down', () async {
      final client = clientFor();
      addTearDown(client.dispose);
      final seen = <RealtimeEvent>[];
      client.events.listen(seen.add);

      await client.connect();
      await server.readyAt(0);
      server.sockets[0].add('not json at all');
      server.send(0, {
        'type': 'ride.status_changed',
        'payload': <String, dynamic>{},
      });
      await Future<void>.delayed(const Duration(milliseconds: 60));

      // The bad frame is dropped; the good one that follows still arrives.
      expect(seen.single.type, 'ride.status_changed');
    });
  });

  group('reconnection — the reason this class exists', () {
    test('comes back after the server drops the connection', () async {
      final client = clientFor();
      addTearDown(client.dispose);

      await client.connect();
      await server.readyAt(0);
      await server.dropAll();

      // A dropped socket is the normal case on these networks, not the
      // exception. A client that gives up is worse than the poll it replaced.
      await server.readyAt(1).timeout(const Duration(seconds: 2));
      expect(server.sockets.length, greaterThanOrEqualTo(2));
    });

    test('fires onReconnect so the caller can resync, but not on first connect',
        () async {
      var reconnects = 0;
      final client = clientFor(onReconnect: () => reconnects++);
      addTearDown(client.dispose);

      await client.connect();
      await server.readyAt(0);
      // The caller has just loaded its own state; telling it to reload is noise.
      expect(reconnects, 0);

      await server.dropAll();
      await server.readyAt(1).timeout(const Duration(seconds: 2));
      await Future<void>.delayed(const Duration(milliseconds: 40));

      // The socket cannot replay what was missed during the gap, so the caller
      // has to ask. Without this a client reconnects and quietly keeps showing
      // state from before the outage.
      expect(reconnects, 1);
    });

    test('stops for good after dispose', () async {
      final client = clientFor();
      await client.connect();
      await server.readyAt(0);

      await client.dispose();
      await server.dropAll();
      await Future<void>.delayed(const Duration(milliseconds: 200));

      // A disposed client reconnecting is a leak that outlives the screen.
      expect(server.sockets.length, 1);
    });

    test('does not retry a token the server refused', () async {
      server.rejectAuth = true;
      var rejected = 0;
      final client = RealtimeClient(
        url: server.url,
        tokenProvider: () async => 'stale-token',
        onAuthRejected: () => rejected++,
        initialBackoff: const Duration(milliseconds: 40),
        maxBackoff: const Duration(milliseconds: 160),
      );
      addTearDown(client.dispose);

      await client.connect();
      await Future<void>.delayed(const Duration(milliseconds: 1500));

      // An expired token does not become valid by waiting. Reconnecting on a
      // loop is a signed-out app hammering a server it cannot talk to - and
      // before this check it made nine attempts in a second and a half.
      expect(rejected, greaterThanOrEqualTo(1));
      expect(server.sockets.length, 1);
    });

    test('still retries an ordinary network drop', () async {
      final client = clientFor();
      addTearDown(client.dispose);

      await client.connect();
      await server.readyAt(0);
      await server.dropAll();

      // The distinction that matters: a dropped connection is retried, a
      // refused token is not.
      await server.readyAt(1).timeout(const Duration(seconds: 3));
      expect(server.sockets.length, greaterThanOrEqualTo(2));
    });
  });
}
