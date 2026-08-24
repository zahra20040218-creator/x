import 'package:intl/intl.dart';

/// Dates for display.
///
/// CLAUDE.md §8: store UTC, display Asia/Baghdad, Gregorian calendar with
/// numerals rendered by the locale.
///
/// `toLocal()` is the whole Baghdad conversion — the device is in the market
/// the app serves, so the OS already knows the offset. Hard-coding +03 would
/// be wrong for anyone testing from elsewhere and would silently drift if
/// Iraq ever changed its offset.
String formatDateTimeAr(DateTime value, {String locale = 'ar'}) =>
    DateFormat('d MMM y • HH:mm', locale).format(value.toLocal());

/// Date only, for grouping a statement by day.
String formatDateAr(DateTime value, {String locale = 'ar'}) =>
    DateFormat('d MMM y', locale).format(value.toLocal());

/// True when the instant falls on the device's current calendar day.
///
/// Compared in LOCAL time on purpose: a driver asking "what did I earn today"
/// means their day, which after 21:00 Baghdad is already tomorrow in UTC.
bool isToday(DateTime value) {
  final now = DateTime.now();
  final local = value.toLocal();
  return local.year == now.year && local.month == now.month && local.day == now.day;
}
