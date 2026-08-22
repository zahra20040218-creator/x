import type { Server } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import type { TokenService } from '../auth/token.service.js';
import type { Logger } from '../common/logger.js';
import { RedisKeys, type RedisPort, type Unsubscribe } from '../redis/redis.port.js';

/**
 * Realtime fan-out over WebSocket.
 *
 * The security property that matters:
 *
 *   **A client never names a channel.**
 *
 * Channels are derived from the subject of the client's own access token, so
 * there is no message a client can send that subscribes it to somebody else's
 * stream. This is not a filter that could be bypassed by crafting a
 * subscription — the subscription API does not accept a channel argument at
 * all. That is what makes `ACCEPTANCE_CHECKLIST.md` check 5 ("does driver A see
 * driver B's data?") answerable with confidence.
 *
 * Redis pub/sub sits behind it because with more than one API process a client
 * is connected to exactly one of them, and a ride state change happens on
 * whichever process handled the request.
 */

export interface RealtimeEvent {
  type:
    | 'ride.status_changed'
    | 'ride.offer'
    | 'ride.offer_revoked'
    | 'driver.location';
  payload: Record<string, unknown>;
}

interface Connection {
  socket: WebSocket;
  userId: string;
  role: 'RIDER' | 'DRIVER' | 'ADMIN';
  unsubscribe: Unsubscribe | null;
  authTimer: NodeJS.Timeout | null;
}

const AUTH_TIMEOUT_MS = 5_000;
const CLOSE_UNAUTHENTICATED = 4401;

export class RealtimeGateway {
  private wss: WebSocketServer | null = null;
  private readonly connections = new Set<Connection>();

  constructor(
    private readonly tokens: TokenService,
    private readonly redis: RedisPort,
    private readonly logger?: Logger,
  ) {}

  attach(server: Server, path = '/v1/realtime'): void {
    this.wss = new WebSocketServer({ server, path });

    this.wss.on('connection', (socket: WebSocket) => {
      const connection: Connection = {
        socket,
        userId: '',
        role: 'RIDER',
        unsubscribe: null,
        authTimer: null,
      };

      // An unauthenticated socket is a free resource for an attacker to hold
      // open. Five seconds to present a token, or it is closed.
      connection.authTimer = setTimeout(() => {
        socket.close(CLOSE_UNAUTHENTICATED, 'authentication timeout');
      }, AUTH_TIMEOUT_MS);

      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        // ws hands over RawData, which may be an array of Buffers for a
        // fragmented frame. Concatenating first is the only form that survives
        // fragmentation intact.
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data as ArrayBuffer).toString('utf8');
        void this.onMessage(connection, text);
      });

      socket.on('close', () => {
        void this.cleanup(connection);
      });

      socket.on('error', () => {
        void this.cleanup(connection);
      });
    });
  }

  private async onMessage(connection: Connection, raw: string): Promise<void> {
    if (connection.userId) return; // Already authenticated; ignore further frames.

    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      connection.socket.close(CLOSE_UNAUTHENTICATED, 'malformed frame');
      return;
    }

    const message = frame as { type?: unknown; token?: unknown };
    if (message.type !== 'auth' || typeof message.token !== 'string') {
      connection.socket.close(CLOSE_UNAUTHENTICATED, 'expected an auth frame');
      return;
    }

    try {
      const claims = await this.tokens.verifyAccessToken(message.token);
      connection.userId = claims.sub;
      connection.role = claims.role;
    } catch {
      connection.socket.close(CLOSE_UNAUTHENTICATED, 'invalid token');
      return;
    }

    if (connection.authTimer) {
      clearTimeout(connection.authTimer);
      connection.authTimer = null;
    }

    // The channel comes from the TOKEN, never from the frame. There is no
    // client-supplied channel name anywhere in this method.
    const channel =
      connection.role === 'DRIVER'
        ? RedisKeys.driverChannel(connection.userId)
        : RedisKeys.riderChannel(connection.userId);

    connection.unsubscribe = await this.redis.subscribe(channel, (payload) => {
      if (connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.send(payload);
      }
    });

    this.connections.add(connection);
    connection.socket.send(JSON.stringify({ type: 'ready' }));
  }

  private async cleanup(connection: Connection): Promise<void> {
    if (connection.authTimer) clearTimeout(connection.authTimer);
    if (connection.unsubscribe) await connection.unsubscribe().catch(() => undefined);
    this.connections.delete(connection);
  }

  /** Publish to a rider's own channel. */
  async toRider(userId: string, event: RealtimeEvent): Promise<void> {
    await this.redis.publish(RedisKeys.riderChannel(userId), JSON.stringify(event));
  }

  /** Publish to a driver's own channel. */
  async toDriver(userId: string, event: RealtimeEvent): Promise<void> {
    await this.redis.publish(RedisKeys.driverChannel(userId), JSON.stringify(event));
  }

  async close(): Promise<void> {
    for (const connection of [...this.connections]) {
      await this.cleanup(connection);
      connection.socket.close(1001, 'server shutting down');
    }
    this.wss?.close();
    this.wss = null;
  }

  /** Test/ops visibility. Not a channel listing — just a count. */
  get connectionCount(): number {
    return this.connections.size;
  }
}
