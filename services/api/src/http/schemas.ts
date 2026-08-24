import { z } from 'zod';

/**
 * Request schemas, one per endpoint in `docs/api-contract.yaml`.
 *
 * CLAUDE.md §12.1 forbids inventing an endpoint that is not in the contract.
 * Keeping the schemas in one file next to each other makes a drift between
 * code and contract visible in review rather than discoverable at runtime.
 *
 * Every money field is `.int()`. A client sending 12500.5 is rejected at the
 * boundary, not rounded somewhere downstream (CLAUDE.md §6.1).
 */

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const UuidSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const VerifyOtpSchema = z.object({
  firebaseIdToken: z.string().min(1).max(4096),
  role: z.enum(['RIDER', 'DRIVER']),
  displayName: z.string().min(1).max(120).optional(),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

export const UpdateMeSchema = z.object({
  displayName: z.string().min(1).max(120),
});

// ---------------------------------------------------------------------------
// Rider
// ---------------------------------------------------------------------------

export const FareEstimateSchema = z.object({
  pickup: LatLngSchema,
  dropoff: LatLngSchema,
});

export const CreateRideSchema = z.object({
  pickup: LatLngSchema,
  pickupAddress: z.string().max(400).optional(),
  dropoff: LatLngSchema,
  dropoffAddress: z.string().max(400).optional(),
  // GATEWAY exists in the schema but is rejected in v1 (CLAUDE.md §7).
  paymentMethod: z.literal('CASH').default('CASH'),
});

export const ListRidesQuerySchema = z.object({
  status: z
    .enum([
      'REQUESTED', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS',
      'COMPLETED', 'CANCELLED_BY_RIDER', 'CANCELLED_BY_DRIVER',
      'CANCELLED_IN_TRIP', 'EXPIRED', 'NO_DRIVERS_FOUND',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export const CancelRideSchema = z.object({
  reason: z.string().max(400).optional(),
});

export const RateRideSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

export const CompleteRideSchema = z.object({
  actualDistanceM: z.number().int().min(0).max(1_000_000).optional(),
});

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export const SetAvailabilitySchema = z
  .object({
    availability: z.enum(['ONLINE', 'OFFLINE']),
    position: LatLngSchema.optional(),
  })
  .refine((v) => v.availability === 'OFFLINE' || v.position !== undefined, {
    // Going ONLINE without a position would leave the driver "online" but
    // absent from the geo set, and therefore unmatchable - visible to them,
    // invisible to every rider.
    message: 'A position is required when going ONLINE.',
    path: ['position'],
  });

export const LocationSampleSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).optional(),
  headingDeg: z.number().min(0).max(360).optional(),
  speedMps: z.number().min(0).max(200).optional(),
  recordedAt: z.coerce.date(),
});

export const ReportLocationSchema = z.object({
  // A batch, because the driver app buffers offline and flushes on reconnect
  // (CLAUDE.md §5.3). Capped so one request cannot pin the event loop.
  samples: z.array(LocationSampleSchema).min(1).max(200),
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const CreateDriverSchema = z.object({
  phone: z.string().min(6).max(20),
  displayName: z.string().min(1).max(120),
  vehiclePlate: z.string().min(1).max(40),
  vehicleModel: z.string().min(1).max(80),
  vehicleColor: z.string().min(1).max(40),
});

export const UpdateDriverSchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    vehiclePlate: z.string().min(1).max(40).optional(),
    vehicleModel: z.string().min(1).max(80).optional(),
    vehicleColor: z.string().min(1).max(40).optional(),
    isSuspended: z.boolean().optional(),
    suspendedReason: z.string().max(400).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

export const TopUpWalletSchema = z.object({
  // Whole IQD. A fractional value is rejected here, never rounded.
  amountIqd: z.number().int().min(1).max(100_000_000),
  reference: z.string().max(200).optional(),
});

export const UpdateConfigSchema = z
  .object({
    commission_bps: z.number().int().min(0).max(10_000).optional(),
    fare_base_iqd: z.number().int().min(0).max(1_000_000).optional(),
    fare_per_km_iqd: z.number().int().min(0).max(1_000_000).optional(),
    fare_per_minute_iqd: z.number().int().min(0).max(1_000_000).optional(),
    fare_minimum_iqd: z.number().int().min(0).max(1_000_000).optional(),
    fare_rounding_iqd: z.number().int().min(1).max(100_000).optional(),
    offer_timeout_seconds: z.number().int().min(5).max(120).optional(),
    search_radius_meters: z.number().int().min(500).max(50_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one configuration key must be supplied.',
  });

export const OpenDisputeSchema = z.object({
  rideId: UuidSchema,
  reasonCode: z.enum(['FARE_WRONG', 'DRIVER_NO_SHOW', 'RIDER_NO_SHOW', 'UNSAFE', 'OTHER']),
  description: z.string().max(2000).optional(),
});

export const ResolveDisputeSchema = z.object({
  outcome: z.enum(['RESOLVED', 'REJECTED']),
  resolution: z.string().min(1).max(2000),
  adjustmentIqd: z.number().int().min(-100_000_000).max(100_000_000).optional(),
});

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const IdempotencyKeySchema = z.string().uuid();

/**
 * Device registration. 4096 is FCM's documented maximum token length; a longer
 * value is not a token and must be refused at the boundary rather than stored.
 */
export const RegisterDeviceSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(['ANDROID', 'IOS']),
});

export const UnregisterDeviceSchema = z.object({
  token: z.string().min(1).max(4096),
});

/**
 * Recording that an administrator checked a driver's document.
 *
 * `reference` is the number printed on the document, not the document. v1
 * stores no images - see migration 0010.
 */
export const RecordDriverDocumentSchema = z.object({
  status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']),
  reference: z.string().max(120).optional(),
  /**
   * `YYYY-MM-DD`. A date, not a timestamp: documents expire on a day, and a
   * timestamp would make the boundary depend on the reader's timezone.
   */
  expiresAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expiresAt must be YYYY-MM-DD')
    .optional(),
  note: z.string().max(500).optional(),
});

export type RecordDriverDocumentBody = z.infer<typeof RecordDriverDocumentSchema>;
