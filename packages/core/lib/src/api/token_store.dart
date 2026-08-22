import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where session tokens live.
///
/// A port, so tests do not need a platform channel — and so the storage choice
/// is a single decision in one place rather than scattered reads.
abstract class TokenStore {
  Future<String?> accessToken();
  Future<String?> refreshToken();
  Future<void> save({
    required String accessToken,
    required String refreshToken,
  });
  Future<void> clear();
}

/// Backed by the platform keystore.
///
/// NOT SharedPreferences. A refresh token is a long-lived credential, and on a
/// rooted handset — common enough in this market to plan for — SharedPreferences
/// is a world-readable XML file. `EncryptedSharedPreferences` puts it behind the
/// Android keystore instead.
class SecureTokenStore implements TokenStore {
  SecureTokenStore({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  static const _accessKey = 'rideapp.accessToken';
  static const _refreshKey = 'rideapp.refreshToken';

  final FlutterSecureStorage _storage;

  /// Cached in memory so the hot path (every request adds a header) does not
  /// hit the keystore, which is a platform channel round trip.
  String? _cachedAccess;

  @override
  Future<String?> accessToken() async =>
      _cachedAccess ??= await _storage.read(key: _accessKey);

  @override
  Future<String?> refreshToken() => _storage.read(key: _refreshKey);

  @override
  Future<void> save({
    required String accessToken,
    required String refreshToken,
  }) async {
    _cachedAccess = accessToken;
    await _storage.write(key: _accessKey, value: accessToken);
    await _storage.write(key: _refreshKey, value: refreshToken);
  }

  @override
  Future<void> clear() async {
    _cachedAccess = null;
    await _storage.delete(key: _accessKey);
    await _storage.delete(key: _refreshKey);
  }
}

/// In-memory store for tests and previews.
class InMemoryTokenStore implements TokenStore {
  String? _access;
  String? _refresh;

  @override
  Future<String?> accessToken() async => _access;

  @override
  Future<String?> refreshToken() async => _refresh;

  @override
  Future<void> save({
    required String accessToken,
    required String refreshToken,
  }) async {
    _access = accessToken;
    _refresh = refreshToken;
  }

  @override
  Future<void> clear() async {
    _access = null;
    _refresh = null;
  }
}
