import type { RealtimeEvent } from './realtime.gateway.js';

/**
 * Where ride events go.
 *
 * A narrow port rather than the `RealtimeGateway` class, for two reasons. It
 * keeps `RideService` testable without a WebSocket server, and it is the seam
 * at which a second transport could be added later — the driver app is offered
 * a ride over a socket today and could equally be woken by FCM when the socket
 * is not connected.
 *
 * ## Why this exists at all
 *
 * The gateway was attached in `main.ts`, clients authenticated and subscribed,
 * and `toRider`/`toDriver` were called from nowhere except the gateway's own
 * tests. So the realtime channel ran and carried nothing:
 *
 *   - The driver app never connected to it. It polled `GET
 *     /driver/offers/current` every 5 seconds. Offers expire in 15, so up to a
 *     third of the window a driver has to decide was spent before the offer
 *     appeared on their screen.
 *
 *   - The rider app DID connect and had a `ride.status_changed` handler, for an
 *     event nothing ever published. Its 8-second poll timer was doing the work.
 *
 *   - `driver.location` was a declared event type with no publisher, which is
 *     why a rider could not watch their driver move.
 */
export interface RideEventPublisher {
  toRider(userId: string, event: RealtimeEvent): Promise<void>;
  toDriver(userId: string, event: RealtimeEvent): Promise<void>;
}
