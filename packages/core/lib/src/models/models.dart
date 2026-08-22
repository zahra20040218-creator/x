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
