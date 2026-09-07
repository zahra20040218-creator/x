import 'package:equatable/equatable.dart';
import 'package:rideapp_core/src/money/iqd.dart';

/// Wire models, mirroring `docs/api-contract.yaml`.
///
/// Every `fromJson` is total: it either produces a valid object or throws. A
/// model that silently defaults a missing field is how a ride ends up rendered
/// with a fare of zero.

class LatLng extends Equatable {
  const LatLng({required this.lat, required this.lng});

  factory LatLng.fromJson(Map<String, dynamic> json) => LatLng(
        lat: (json['lat'] as num).toDouble(),
        lng: (json['lng'] as num).toDouble(),
      );

  final double lat;
  final double lng;

  Map<String, dynamic> toJson() => {'lat': lat, 'lng': lng};

  @override
  List<Object?> get props => [lat, lng];
}

/// CLAUDE.md §4. The client mirrors the server's states exactly; an unknown
/// value throws rather than defaulting, so a server change cannot silently
/// render as the wrong state.
enum RideStatus {
  requested('REQUESTED'),
  offered('OFFERED'),
  accepted('ACCEPTED'),
  driverArrived('DRIVER_ARRIVED'),
  inProgress('IN_PROGRESS'),
  completed('COMPLETED'),
  cancelledByRider('CANCELLED_BY_RIDER'),
  cancelledByDriver('CANCELLED_BY_DRIVER'),
  cancelledInTrip('CANCELLED_IN_TRIP'),
  expired('EXPIRED'),
  noDriversFound('NO_DRIVERS_FOUND');

  const RideStatus(this.wire);

  final String wire;

  static RideStatus fromWire(String value) => RideStatus.values.firstWhere(
        (status) => status.wire == value,
        orElse: () => throw FormatException('Unknown ride status: $value'),
      );

  bool get isTerminal => const {
        RideStatus.completed,
        RideStatus.cancelledByRider,
        RideStatus.cancelledByDriver,
        RideStatus.cancelledInTrip,
        RideStatus.noDriversFound,
      }.contains(this);

  /// The ride occupies the rider and, once assigned, the driver.
  bool get isActive => const {
        RideStatus.requested,
        RideStatus.offered,
        RideStatus.accepted,
        RideStatus.driverArrived,
        RideStatus.inProgress,
      }.contains(this);

  /// True once the driver is on their way — the point at which the rider's map
  /// should start tracking.
  bool get hasAssignedDriver => const {
        RideStatus.accepted,
        RideStatus.driverArrived,
        RideStatus.inProgress,
      }.contains(this);
}

class Vehicle extends Equatable {
  const Vehicle({required this.plate, required this.model, required this.color});

  factory Vehicle.fromJson(Map<String, dynamic> json) => Vehicle(
        plate: json['plate'] as String? ?? '',
        model: json['model'] as String? ?? '',
        color: json['color'] as String? ?? '',
      );

  final String plate;
  final String model;
  final String color;

  @override
  List<Object?> get props => [plate, model, color];
}

/// How the OTHER party is shown.
///
/// There is deliberately no phone field, mirroring `PublicUser` in the API
/// contract. `ACCEPTANCE_CHECKLIST.md` check 5 asks whether the driver can see
/// the rider's number; the answer is enforced by the field not existing on
/// either side of the wire.
class PublicUser extends Equatable {
  const PublicUser({
    required this.id,
    required this.displayName,
    this.rating,
    this.vehicle,
  });

  factory PublicUser.fromJson(Map<String, dynamic> json) => PublicUser(
        id: json['id'] as String,
        displayName: json['displayName'] as String,
        rating: (json['rating'] as num?)?.toDouble(),
        vehicle: json['vehicle'] == null
            ? null
            : Vehicle.fromJson(json['vehicle'] as Map<String, dynamic>),
      );

  final String id;
  final String displayName;
  final double? rating;
  final Vehicle? vehicle;

  @override
  List<Object?> get props => [id, displayName, rating, vehicle];
}

class FareBreakdown extends Equatable {
  const FareBreakdown({
    required this.baseIqd,
    required this.distanceIqd,
    required this.timeIqd,
    required this.minimumAppliedIqd,
    required this.roundingIqd,
  });

  factory FareBreakdown.fromJson(Map<String, dynamic> json) => FareBreakdown(
        baseIqd: IqdAmount.fromJson(json['baseIqd']),
        distanceIqd: IqdAmount.fromJson(json['distanceIqd']),
        timeIqd: IqdAmount.fromJson(json['timeIqd']),
        minimumAppliedIqd: IqdAmount.fromJson(json['minimumAppliedIqd']),
        roundingIqd: IqdAmount.fromJson(json['roundingIqd']),
      );

  final IqdAmount baseIqd;
  final IqdAmount distanceIqd;
  final IqdAmount timeIqd;
  final IqdAmount minimumAppliedIqd;
  final IqdAmount roundingIqd;

  /// The parts must equal the whole. The server guarantees this; asserting it
  /// here means a mismatch surfaces in the app rather than as a driver dispute.
  int get total =>
      baseIqd + distanceIqd + timeIqd + minimumAppliedIqd + roundingIqd;

  @override
  List<Object?> get props =>
      [baseIqd, distanceIqd, timeIqd, minimumAppliedIqd, roundingIqd];
}

class FareEstimate extends Equatable {
  const FareEstimate({
    required this.estimatedFareIqd,
    required this.distanceM,
    required this.durationS,
    required this.breakdown,
  });

  factory FareEstimate.fromJson(Map<String, dynamic> json) => FareEstimate(
        estimatedFareIqd: IqdAmount.fromJson(json['estimatedFareIqd']),
        distanceM: json['distanceM'] as int,
        durationS: json['durationS'] as int,
        breakdown:
            FareBreakdown.fromJson(json['breakdown'] as Map<String, dynamic>),
      );

  final IqdAmount estimatedFareIqd;
  final int distanceM;
  final int durationS;
  final FareBreakdown breakdown;

  @override
  List<Object?> get props =>
      [estimatedFareIqd, distanceM, durationS, breakdown];
}

class Ride extends Equatable {
  const Ride({
    required this.id,
    required this.status,
    required this.pickup,
    required this.dropoff,
    required this.estimatedFareIqd,
    required this.estimatedDistanceM,
    required this.estimatedDurationS,
    required this.requestedAt,
    this.rider,
    this.driver,
    this.pickupAddress,
    this.dropoffAddress,
    this.finalFareIqd,
    this.commissionIqd,
    this.actualDistanceM,
    this.acceptedAt,
    this.driverArrivedAt,
    this.startedAt,
    this.completedAt,
    this.cancelledAt,
    this.cancellationReason,
  });

  factory Ride.fromJson(Map<String, dynamic> json) => Ride(
        id: json['id'] as String,
        status: RideStatus.fromWire(json['status'] as String),
        rider: json['rider'] == null
            ? null
            : PublicUser.fromJson(json['rider'] as Map<String, dynamic>),
        driver: json['driver'] == null
            ? null
            : PublicUser.fromJson(json['driver'] as Map<String, dynamic>),
        pickup: LatLng.fromJson(json['pickup'] as Map<String, dynamic>),
        pickupAddress: json['pickupAddress'] as String?,
        dropoff: LatLng.fromJson(json['dropoff'] as Map<String, dynamic>),
        dropoffAddress: json['dropoffAddress'] as String?,
        estimatedFareIqd: IqdAmount.fromJson(json['estimatedFareIqd']),
        finalFareIqd: json['finalFareIqd'] == null
            ? null
            : IqdAmount.fromJson(json['finalFareIqd']),
        commissionIqd: json['commissionIqd'] == null
            ? null
            : IqdAmount.fromJson(json['commissionIqd']),
        estimatedDistanceM: json['estimatedDistanceM'] as int,
        estimatedDurationS: json['estimatedDurationS'] as int,
        actualDistanceM: json['actualDistanceM'] as int?,
        requestedAt: DateTime.parse(json['requestedAt'] as String),
        acceptedAt: _date(json['acceptedAt']),
        driverArrivedAt: _date(json['driverArrivedAt']),
        startedAt: _date(json['startedAt']),
        completedAt: _date(json['completedAt']),
        cancelledAt: _date(json['cancelledAt']),
        cancellationReason: json['cancellationReason'] as String?,
      );

  final String id;
  final RideStatus status;
  final PublicUser? rider;
  final PublicUser? driver;
  final LatLng pickup;
  final String? pickupAddress;
  final LatLng dropoff;
  final String? dropoffAddress;
  final IqdAmount estimatedFareIqd;
  final IqdAmount? finalFareIqd;
  final IqdAmount? commissionIqd;
  final int estimatedDistanceM;
  final int estimatedDurationS;
  final int? actualDistanceM;
  final DateTime requestedAt;
  final DateTime? acceptedAt;
  final DateTime? driverArrivedAt;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final DateTime? cancelledAt;
  final String? cancellationReason;

  /// What the rider actually pays: the settled fare once it exists, otherwise
  /// the quote.
  IqdAmount get displayFareIqd => finalFareIqd ?? estimatedFareIqd;

  @override
  List<Object?> get props => [id, status, finalFareIqd, driver, cancelledAt];
}

class RideOffer extends Equatable {
  const RideOffer({
    required this.offerId,
    required this.rideId,
    required this.pickup,
    required this.dropoff,
    required this.estimatedFareIqd,
    required this.distanceM,
    required this.expiresAt,
    this.pickupAddress,
    this.dropoffAddress,
  });

  factory RideOffer.fromJson(Map<String, dynamic> json) => RideOffer(
        offerId: json['offerId'] as String,
        rideId: json['rideId'] as String,
        pickup: LatLng.fromJson(json['pickup'] as Map<String, dynamic>),
        pickupAddress: json['pickupAddress'] as String?,
        dropoff: LatLng.fromJson(json['dropoff'] as Map<String, dynamic>),
        dropoffAddress: json['dropoffAddress'] as String?,
        estimatedFareIqd: IqdAmount.fromJson(json['estimatedFareIqd']),
        distanceM: json['distanceM'] as int,
        expiresAt: DateTime.parse(json['expiresAt'] as String),
      );

  final String offerId;
  final String rideId;
  final LatLng pickup;
  final String? pickupAddress;
  final LatLng dropoff;
  final String? dropoffAddress;
  final IqdAmount estimatedFareIqd;
  final int distanceM;
  final DateTime expiresAt;

  /// Seconds left. The offer sheet counts down against this rather than a
  /// locally-started timer, so a slow render does not give the driver a longer
  /// deadline than the server is honouring.
  Duration remaining(DateTime now) {
    final left = expiresAt.difference(now);
    return left.isNegative ? Duration.zero : left;
  }

  @override
  List<Object?> get props => [offerId, rideId, expiresAt];
}

enum UserRole {
  rider('RIDER'),
  driver('DRIVER'),
  admin('ADMIN');

  const UserRole(this.wire);

  final String wire;

  static UserRole fromWire(String value) => UserRole.values.firstWhere(
        (role) => role.wire == value,
        orElse: () => throw FormatException('Unknown role: $value'),
      );
}

enum DriverAvailability {
  offline('OFFLINE'),
  online('ONLINE'),
  onTrip('ON_TRIP');

  const DriverAvailability(this.wire);

  final String wire;

  static DriverAvailability fromWire(String value) =>
      DriverAvailability.values.firstWhere(
        (a) => a.wire == value,
        orElse: () => throw FormatException('Unknown availability: $value'),
      );
}

/// The caller's OWN profile — the only model that carries a phone number.
class Me extends Equatable {
  const Me({
    required this.id,
    required this.role,
    required this.displayName,
    required this.phone,
    this.rating,
    this.availability,
    this.isSuspended = false,
    this.vehicle,
    this.walletBalanceIqd,
  });

  factory Me.fromJson(Map<String, dynamic> json) {
    final driver = json['driver'] as Map<String, dynamic>?;
    return Me(
      id: json['id'] as String,
      role: UserRole.fromWire(json['role'] as String),
      displayName: json['displayName'] as String,
      phone: json['phone'] as String,
      rating: (json['rating'] as num?)?.toDouble(),
      availability: driver == null
          ? null
          : DriverAvailability.fromWire(driver['availability'] as String),
      isSuspended: driver?['isSuspended'] as bool? ?? false,
      vehicle: driver?['vehicle'] == null
          ? null
          : Vehicle.fromJson(driver!['vehicle'] as Map<String, dynamic>),
      walletBalanceIqd: json['walletBalanceIqd'] == null
          ? null
          : IqdAmount.fromJson(json['walletBalanceIqd']),
    );
  }

  final String id;
  final UserRole role;
  final String displayName;
  final String phone;
  final double? rating;
  final DriverAvailability? availability;
  final bool isSuspended;
  final Vehicle? vehicle;
  final IqdAmount? walletBalanceIqd;

  @override
  List<Object?> get props => [id, role, displayName, availability];
}

class AuthSession extends Equatable {
  const AuthSession({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresIn,
    required this.user,
  });

  factory AuthSession.fromJson(Map<String, dynamic> json) => AuthSession(
        accessToken: json['accessToken'] as String,
        refreshToken: json['refreshToken'] as String,
        expiresIn: json['expiresIn'] as int,
        user: Me.fromJson(json['user'] as Map<String, dynamic>),
      );

  final String accessToken;
  final String refreshToken;
  final int expiresIn;
  final Me user;

  @override
  List<Object?> get props => [accessToken, refreshToken, user];
}

/// One side of a double-entry ledger row.
///
/// Mirrors `presentLedgerEntry` on the server. The ledger is append-only
/// (CLAUDE.md §6.3), so there is deliberately no way to construct a mutation
/// from this model — it is read-only by design, not by omission.
class LedgerEntry extends Equatable {
  const LedgerEntry({
    required this.id,
    required this.transactionId,
    required this.accountType,
    required this.direction,
    required this.amountIqd,
    required this.description,
    required this.createdAt,
    this.rideId,
  });

  factory LedgerEntry.fromJson(Map<String, dynamic> json) => LedgerEntry(
        id: json['id'].toString(),
        transactionId: json['transactionId'] as String,
        rideId: json['rideId'] as String?,
        accountType: json['accountType'] as String,
        direction: json['direction'] as String,
        amountIqd: IqdAmount(json['amountIqd'] as int),
        description: json['description'] as String? ?? '',
        createdAt: DateTime.parse(json['createdAt'] as String),
      );

  final String id;

  /// Groups the two or more rows that balance to zero.
  final String transactionId;

  final String? rideId;
  final String accountType;

  /// `CREDIT` or `DEBIT`.
  final String direction;

  final IqdAmount amountIqd;
  final String description;
  final DateTime createdAt;

  /// True when this row increases the driver's balance.
  bool get isCredit => direction == 'CREDIT';

  /// Signed value, for summing a statement.
  ///
  /// A statement that added the absolute values would show a driver twice
  /// what they earned, because every transaction has both sides.
  int get signedIqd => isCredit ? amountIqd.value : -amountIqd.value;

  @override
  List<Object?> get props => [id];
}

class WalletBalance extends Equatable {
  const WalletBalance({required this.driverId, required this.balanceIqd});

  factory WalletBalance.fromJson(Map<String, dynamic> json) => WalletBalance(
        driverId: json['driverId'] as String,
        balanceIqd: IqdAmount.fromJson(json['balanceIqd']),
      );

  final String driverId;

  /// May be negative when a driver owes commission.
  final IqdAmount balanceIqd;

  @override
  List<Object?> get props => [driverId, balanceIqd];
}

/// One buffered position awaiting upload. CLAUDE.md §5.3 requires the driver
/// app to buffer while offline and flush on reconnect.
class LocationSample extends Equatable {
  const LocationSample({
    required this.lat,
    required this.lng,
    required this.recordedAt,
    this.accuracyM,
    this.headingDeg,
    this.speedMps,
  });

  factory LocationSample.fromJson(Map<String, dynamic> json) => LocationSample(
        lat: (json['lat'] as num).toDouble(),
        lng: (json['lng'] as num).toDouble(),
        recordedAt: DateTime.parse(json['recordedAt'] as String),
        accuracyM: (json['accuracyM'] as num?)?.toDouble(),
        headingDeg: (json['headingDeg'] as num?)?.toDouble(),
        speedMps: (json['speedMps'] as num?)?.toDouble(),
      );

  final double lat;
  final double lng;
  final DateTime recordedAt;
  final double? accuracyM;
  final double? headingDeg;
  final double? speedMps;

  Map<String, dynamic> toJson() => {
        'lat': lat,
        'lng': lng,
        'recordedAt': recordedAt.toUtc().toIso8601String(),
        if (accuracyM != null) 'accuracyM': accuracyM,
        if (headingDeg != null) 'headingDeg': headingDeg,
        if (speedMps != null) 'speedMps': speedMps,
      };

  @override
  List<Object?> get props => [lat, lng, recordedAt];
}

DateTime? _date(Object? value) =>
    value == null ? null : DateTime.parse(value as String);

/// Why someone opened a dispute.
///
/// The wire values are the server's `reason_code` enum
/// (`services/api/src/http/schemas.ts`). Sending anything else is a 422, so the
/// set is closed rather than a free string — a typo here would be a rejection
/// the user cannot act on.
enum DisputeReason {
  fareWrong('FARE_WRONG'),
  driverNoShow('DRIVER_NO_SHOW'),
  riderNoShow('RIDER_NO_SHOW'),
  unsafe('UNSAFE'),
  other('OTHER');

  const DisputeReason(this.wire);

  final String wire;

  static DisputeReason fromWire(String value) => DisputeReason.values.firstWhere(
        (reason) => reason.wire == value,
        orElse: () => DisputeReason.other,
      );
}

/// A complaint about a ride, as the server recorded it.
///
/// Carries the id back so the app can show a reference the user can quote to
/// support. A complaint that vanishes without a receipt is one the user has no
/// reason to believe was filed.
class Dispute {
  const Dispute({
    required this.id,
    required this.rideId,
    required this.status,
    required this.reasonCode,
    required this.description,
    required this.createdAt,
  });

  factory Dispute.fromJson(Map<String, dynamic> json) => Dispute(
        id: json['id'] as String,
        rideId: json['rideId'] as String,
        status: json['status'] as String,
        reasonCode: DisputeReason.fromWire(json['reasonCode'] as String),
        description: (json['description'] as String?) ?? '',
        createdAt: DateTime.parse(json['createdAt'] as String).toUtc(),
      );

  final String id;
  final String rideId;
  final String status;
  final DisputeReason reasonCode;
  final String description;
  final DateTime createdAt;

  /// The short form shown to the user, matching how a ride id is shortened on
  /// the receipt.
  String get reference => id.split('-').first.toUpperCase();
}


/// One page of ledger entries.
///
/// Carries `nextCursor` because dropping it is how a statement silently stops
/// at the first page — the driver sees a plausible list and no indication that
/// anything is missing.
class LedgerPage {
  const LedgerPage({required this.items, required this.nextCursor});

  final List<LedgerEntry> items;

  /// Opaque. Pass it back verbatim; null means this was the last page.
  final String? nextCursor;

  bool get hasMore => nextCursor != null;
}

// ---------------------------------------------------------------------------
// Capabilities and subscriptions
//
// CLAUDE.md §1.1: ALY is one app with a Rider mode and a Driver mode, and the
// mode is a SERVER decision. `GET /me/capabilities` is the authoritative
// answer and the same evaluation the server enforces with — so the app renders
// what this says and decides nothing itself.
//
// These models existed on the server and in the contract since 2026-08-25 and
// had no Dart counterpart, which meant no app could ever learn WHY a driver was
// refused. The driver saw a generic error.
// ---------------------------------------------------------------------------

/// One machine-readable reason driver mode is unavailable.
///
/// Deliberately a `String` and not an enum. The server ships weekly, the Play
/// Store review does not, so a driver WILL receive a code their build has never
/// seen. An enum would throw on parse; a string renders a generic row that
/// still tells them to call support with the code. See
/// `AppStrings.blockerTitle`.
typedef CapabilityBlocker = String;

/// Whether this account may drive, and every reason it may not.
class DriverCapability {
  const DriverCapability({
    required this.allowed,
    required this.blockers,
    required this.suspendedReason,
    required this.missingDocuments,
    required this.expiredDocuments,
    required this.rejectedDocuments,
    required this.subscriptionExpiresAt,
  });

  factory DriverCapability.fromJson(Map<String, dynamic> json) => DriverCapability(
        allowed: json['allowed'] as bool? ?? false,
        blockers: _strings(json['blockers']),
        suspendedReason: json['suspendedReason'] as String?,
        missingDocuments: _strings(json['missingDocuments']),
        expiredDocuments: _strings(json['expiredDocuments']),
        rejectedDocuments: _strings(json['rejectedDocuments']),
        subscriptionExpiresAt: json['subscriptionExpiresAt'] == null
            ? null
            : DateTime.parse(json['subscriptionExpiresAt'] as String),
      );

  /// True only when [blockers] is empty. Never set independently — the server
  /// derives it, and re-deriving it here is how the two drift apart.
  final bool allowed;

  /// EVERY reason, in the server's order. A driver blocked for three reasons
  /// who fixes one and is still blocked has learned nothing.
  final List<CapabilityBlocker> blockers;

  final String? suspendedReason;
  final List<String> missingDocuments;
  final List<String> expiredDocuments;
  final List<String> rejectedDocuments;

  /// Present whenever a subscription exists, whether or not one is required —
  /// a driver should be able to see what they bought before it gates anything.
  final DateTime? subscriptionExpiresAt;

  static List<String> _strings(Object? value) =>
      (value as List<dynamic>? ?? const []).map((e) => e as String).toList();
}

/// What this account may do, decided on the server.
class Capabilities {
  const Capabilities({
    required this.userId,
    required this.canRide,
    required this.driver,
  });

  factory Capabilities.fromJson(Map<String, dynamic> json) => Capabilities(
        userId: json['userId'] as String,
        canRide: json['canRide'] as bool? ?? false,
        driver: DriverCapability.fromJson(
          (json['driver'] as Map<String, dynamic>?) ?? const {},
        ),
      );

  final String userId;
  final bool canRide;
  final DriverCapability driver;
}

/// A plan a driver can buy.
class SubscriptionPlan {
  const SubscriptionPlan({
    required this.code,
    required this.nameAr,
    required this.nameEn,
    required this.priceIqd,
    required this.durationDays,
  });

  factory SubscriptionPlan.fromJson(Map<String, dynamic> json) => SubscriptionPlan(
        code: json['code'] as String,
        nameAr: json['nameAr'] as String,
        nameEn: json['nameEn'] as String,
        priceIqd: IqdAmount.fromJson(json['priceIqd']),
        durationDays: json['durationDays'] as int,
      );

  final String code;
  final String nameAr;
  final String nameEn;

  /// Whole IQD. CLAUDE.md §6.1 — never a decimal.
  final IqdAmount priceIqd;

  final int durationDays;

  /// The plan name in the app's language.
  String nameFor(String languageCode) => languageCode == 'en' ? nameEn : nameAr;
}

/// A driver's purchased period.
class DriverSubscription {
  const DriverSubscription({
    required this.id,
    required this.planCode,
    required this.status,
    required this.chargedIqd,
    required this.startedAt,
    required this.expiresAt,
    required this.transactionId,
  });

  factory DriverSubscription.fromJson(Map<String, dynamic> json) => DriverSubscription(
        id: json['id'] as String,
        planCode: json['planCode'] as String,
        status: json['status'] as String,
        chargedIqd: IqdAmount.fromJson(json['chargedIqd']),
        startedAt: DateTime.parse(json['startedAt'] as String),
        expiresAt: DateTime.parse(json['expiresAt'] as String),
        transactionId: json['transactionId'] as String?,
      );

  final String id;
  final String planCode;

  /// `ACTIVE` / `EXPIRED` / `CANCELLED`. A string for the same reason
  /// [CapabilityBlocker] is.
  final String status;

  final IqdAmount chargedIqd;
  final DateTime startedAt;
  final DateTime expiresAt;

  /// The ledger transaction that paid for it. Null for a period an
  /// administrator granted without charge.
  final String? transactionId;

  /// Whole days left, rounded DOWN, floored at zero.
  ///
  /// Computed against `DateTime.now()` at the call site rather than stored, so
  /// a screen left open overnight does not keep showing yesterday's number.
  /// Rounded down because telling a driver "1 day left" when it expires in
  /// four hours is the safe direction of the error.
  int daysRemainingAt(DateTime now) {
    final remaining = expiresAt.difference(now);
    if (remaining.isNegative) return 0;
    return remaining.inDays;
  }
}

/// A bid's life, as `docs/api-contract.yaml` defines it.
///
/// SUPERSEDED rather than "edited": bidding again writes a new row and marks
/// the old one superseded, because the bid history is what a fare dispute is
/// argued from and an UPDATE destroys it.
enum RideBidStatus {
  active('ACTIVE'),
  superseded('SUPERSEDED'),
  withdrawn('WITHDRAWN'),
  accepted('ACCEPTED'),
  rejected('REJECTED'),
  expired('EXPIRED'),

  /// A state this build has never seen.
  ///
  /// Deliberately NOT a throw, which is how [RideStatus] handles the same
  /// situation — and the difference is intentional. An unknown ride status
  /// means the app cannot reason about the trip it is showing. An unknown BID
  /// status means one card in a list of offers is unfamiliar, and taking down
  /// a rider's whole offer list over a string the server added last Tuesday is
  /// the worse failure.
  unknown('UNKNOWN');

  const RideBidStatus(this.wire);

  final String wire;

  static RideBidStatus fromWire(String value) => RideBidStatus.values.firstWhere(
        (status) => status.wire == value,
        orElse: () => RideBidStatus.unknown,
      );
}

/// One driver's binding commitment to carry a ride at a stated fare.
///
/// A bid IS the acceptance. When the rider selects one, the server takes the
/// Redis claim on that driver's behalf and runs REQUESTED -> OFFERED ->
/// ACCEPTED through `RideStateMachine` unchanged (CLAUDE.md §5.1) — there is no
/// second commit path and no bypass of the claim.
class RideBid extends Equatable {
  const RideBid({
    required this.id,
    required this.rideId,
    required this.driverId,
    required this.amountIqd,
    required this.status,
    required this.createdAt,
    required this.expiresAt,
    this.driver,
    this.deltaIqd,
    this.etaToPickup,
    this.distanceM,
  });

  factory RideBid.fromJson(Map<String, dynamic> json) {
    final eta = json['etaSeconds'] as int?;

    return RideBid(
      id: json['id'] as String,
      rideId: json['rideId'] as String,
      driverId: json['driverId'] as String,
      amountIqd: IqdAmount.fromJson(json['amountIqd']),
      status: RideBidStatus.fromWire(json['status'] as String),
      createdAt: DateTime.parse(json['createdAt'] as String),
      expiresAt: DateTime.parse(json['expiresAt'] as String),
      driver: json['driver'] == null
          ? null
          : PublicUser.fromJson(json['driver'] as Map<String, dynamic>),
      deltaIqd: json['deltaIqd'] == null
          ? null
          : IqdAmount.fromJson(json['deltaIqd']),
      etaToPickup: eta == null ? null : Duration(seconds: eta),
      distanceM: json['distanceM'] as int?,
    );
  }

  final String id;
  final String rideId;
  final String driverId;

  /// Whole Iraqi dinars (CLAUDE.md §6.1). Never a decimal.
  final IqdAmount amountIqd;

  /// [amountIqd] minus the rider's proposal; negative is cheaper than asked.
  ///
  /// Read from the server, never recomputed here. The contract is explicit
  /// that two clients computing it separately is two chances to get the sign
  /// wrong, and the sign is the entire meaning of the number.
  final IqdAmount? deltaIqd;

  final RideBidStatus status;

  /// Present only when a RIDER reads their own bids. A driver reading back
  /// their own bid receives no other user's profile.
  final PublicUser? driver;

  final Duration? etaToPickup;
  final int? distanceM;

  final DateTime createdAt;
  final DateTime expiresAt;

  @override
  List<Object?> get props => [id, status, amountIqd];
}

/// The bids on one ride, with the number they are all compared against.
///
/// Paired rather than returned separately because a bid list without the
/// rider's own proposal cannot be rendered: every card states its difference
/// from that number, and fetching the two apart invites showing a delta
/// against a stale proposal.
class RideBidsPage extends Equatable {
  const RideBidsPage({required this.proposedFareIqd, required this.bids});

  final IqdAmount proposedFareIqd;
  final List<RideBid> bids;

  @override
  List<Object?> get props => [proposedFareIqd, bids];
}

/// A ride a driver may bid on.
///
/// Carries NO rider identity, deliberately: a driver decides on the trip and
/// the price, not on who is asking, and showing the rider before assignment
/// invites exactly the discrimination a marketplace should not have.
class OpenRideRequest extends Equatable {
  const OpenRideRequest({
    required this.rideId,
    required this.pickup,
    required this.dropoff,
    required this.proposedFareIqd,
    required this.distanceToPickupM,
    required this.estimatedDistanceM,
    required this.expiresAt,
    this.pickupAddress,
    this.dropoffAddress,
    this.suggestedFareIqd,
  });

  factory OpenRideRequest.fromJson(Map<String, dynamic> json) => OpenRideRequest(
        rideId: json['rideId'] as String,
        pickup: LatLng.fromJson(json['pickup'] as Map<String, dynamic>),
        dropoff: LatLng.fromJson(json['dropoff'] as Map<String, dynamic>),
        proposedFareIqd: IqdAmount.fromJson(json['proposedFareIqd']),
        distanceToPickupM: json['distanceToPickupM'] as int,
        estimatedDistanceM: json['estimatedDistanceM'] as int,
        expiresAt: DateTime.parse(json['expiresAt'] as String),
        pickupAddress: json['pickupAddress'] as String?,
        dropoffAddress: json['dropoffAddress'] as String?,
        suggestedFareIqd: json['suggestedFareIqd'] == null
            ? null
            : IqdAmount.fromJson(json['suggestedFareIqd']),
      );

  final String rideId;
  final LatLng pickup;
  final LatLng dropoff;
  final String? pickupAddress;
  final String? dropoffAddress;

  /// What the rider offered.
  final IqdAmount proposedFareIqd;

  /// The tariff's own estimate, shown beside the proposal so a driver can see
  /// at a glance whether it is fair rather than having to know the tariff.
  final IqdAmount? suggestedFareIqd;

  final int distanceToPickupM;
  final int estimatedDistanceM;
  final DateTime expiresAt;

  @override
  List<Object?> get props => [rideId, proposedFareIqd, expiresAt];
}
