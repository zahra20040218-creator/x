/// Decisions the redesigned screens make, kept out of the widgets that draw
/// them.
///
/// Both of these would otherwise be an `if` against `DateTime.now()` inside a
/// `build`, which is untestable for the same reason nothing else on these
/// screens was: you cannot reach 4am, or the 59th second of a resend window,
/// by tapping.
library;

/// Which greeting the header carries.
///
/// Two, not three. Arabic has no separately-used "good afternoon"; مساء الخير
/// covers everything after noon, and inventing a third would put a phrase on
/// screen that nobody actually says.
enum Greeting {
  morning,
  evening;

  /// The small hours belong to [evening], deliberately.
  ///
  /// A driver signing on at 3am is the case this exists for. Greeting them
  /// with صباح الخير before dawn, or with nothing at all, both read as a bug
  /// to the person most likely to be looking.
  static Greeting forHour(int hour) =>
      hour >= 5 && hour < 12 ? Greeting.morning : Greeting.evening;
}

/// The wait before a rider may ask for a second OTP.
///
/// A countdown rather than an error after the fact: the design's note is that
/// telling someone "too many requests" *after* they press is worse than not
/// offering the press until it can succeed.
class ResendCountdown {
  ResendCountdown({required this.window});

  final Duration window;

  /// When the last code went out, or null before the first one.
  ///
  /// Written each time a code actually goes out — including the second one, so
  /// a rider cannot walk the window down by resending repeatedly. Null reopens
  /// it, for a rider who went back and changed their number.
  DateTime? sentAt;

  Duration remainingAt(DateTime now) {
    final sentAt = this.sentAt;
    // Nothing has been sent, so there is nothing to wait for. A rider who has
    // not requested a code must not be told to wait two minutes for one.
    if (sentAt == null) return Duration.zero;

    final elapsed = now.difference(sentAt);
    final remaining = window - elapsed;
    // Floored: a screen left open for an hour must not render "-58:00".
    return remaining.isNegative ? Duration.zero : remaining;
  }

  bool canResendAt(DateTime now) => remainingAt(now) == Duration.zero;

  /// `mm:ss`, zero padded, as the design shows it.
  static String format(Duration remaining) {
    final minutes = remaining.inMinutes.toString().padLeft(2, '0');
    final seconds = (remaining.inSeconds % 60).toString().padLeft(2, '0');
    return '$minutes:$seconds';
  }
}
