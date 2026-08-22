import 'package:intl/intl.dart';

/// Whole Iraqi Dinars, on the client side.
///
/// CLAUDE.md §6.1: money is a whole integer, never a float. The server enforces
/// this at its boundary, but the app has to hold the same line — a `double`
/// here becomes `12500.000000000002` on the screen and a support call.
///
/// Dart's `int` is 64-bit on mobile, so there is no precision cliff to guard
/// the way there is in JavaScript. What still needs guarding is the TYPE: this
/// class exists so that a fare cannot silently become a `double` through an
/// arithmetic slip.
extension type const IqdAmount(int value) implements int {
  /// Parse an amount as it arrives from the API.
  ///
  /// Throws on a fractional value rather than truncating it. If the server ever
  /// sends `12500.5`, that is a defect on the server and rounding it here would
  /// hide it until the numbers stopped adding up.
  factory IqdAmount.fromJson(Object? json) {
    if (json is int) return IqdAmount(json);
    if (json is double) {
      if (json != json.roundToDouble()) {
        throw FormatException('IQD amount must be a whole number, got $json');
      }
      return IqdAmount(json.toInt());
    }
    if (json is String) {
      final parsed = int.tryParse(json);
      if (parsed == null) {
        throw FormatException('IQD amount is not an integer: $json');
      }
      return IqdAmount(parsed);
    }
    throw FormatException('Unsupported IQD amount: $json');
  }

  static const IqdAmount zero = IqdAmount(0);

  int toJson() => value;
}

/// Display formatting. CLAUDE.md §8: `12,500 د.ع` — grouped thousands, no
/// decimals, ever.
class IqdFormatter {
  IqdFormatter._();

  static final NumberFormat _grouped = NumberFormat('#,##0', 'en');

  /// `12500` -> `12,500 د.ع`
  ///
  /// Western digits with an Arabic currency mark is the convention Iraqi apps
  /// and banks actually use; rendering the digits in Arabic-Indic makes prices
  /// harder to scan for most users, not easier.
  static String format(int amountIqd) {
    final sign = amountIqd < 0 ? '-' : '';
    return '$sign${_grouped.format(amountIqd.abs())} د.ع';
  }

  /// Without the currency mark, for places that label the unit separately.
  static String formatBare(int amountIqd) {
    final sign = amountIqd < 0 ? '-' : '';
    return '$sign${_grouped.format(amountIqd.abs())}';
  }
}
