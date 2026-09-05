import 'package:flutter/widgets.dart';

/// Spacing, radius, elevation and motion.
///
/// One file because they are one decision: how much room things take, how soft
/// their corners are, how far off the page they sit, and how quickly they move.
/// Splitting them into four files makes them four decisions and they drift.

/// A 4-point grid.
///
/// Every gap in the product is one of these. The rule is absolute, and the
/// reason is not tidiness: a layout built from 12, 13, 17 and 23 cannot be
/// scanned. The eye reads unequal gaps as unequal *relationships*, so a card
/// with 13px above its title and 17px below reads as though the title belongs
/// to what is beneath it. That is a hierarchy bug expressed as a spacing bug,
/// and it is why "the screen feels off" is so hard to diagnose.
abstract final class AlySpacing {
  /// 4 — between an icon and its own label. The smallest gap in the system.
  ///
  /// There was a `xxs = 2` here. It was removed rather than kept as a
  /// documented exception: a grid with one value off it is not a grid, and the
  /// exception would have been copied. Where 2pt looked necessary the real
  /// answer was a border or a line-height, not a gap.
  static const double xs = 4;

  /// 8 — inside a chip, between stacked lines of one idea.
  static const double sm = 8;

  /// 12 — between two related rows.
  static const double md = 12;

  /// 16 — the default. Screen gutters, card padding.
  static const double lg = 16;

  /// 24 — between two sections of one screen.
  static const double xl = 24;

  /// 32 — above a primary action, below a screen title.
  static const double xxl = 32;

  /// 48 — around an empty state, a hero moment.
  static const double xxxl = 48;

  /// The screen gutter. Named separately from [lg] because it is a layout
  /// decision, not a spacing one, and a tablet layout will change this without
  /// changing card padding.
  static const double gutter = 16;

  /// Minimum tap target.
  ///
  /// 56, not the platform's 48. A driver taps "accept" one-handed, in a moving
  /// car, against a 15-second deadline, wearing whatever they are wearing in a
  /// Baghdad summer. The platform minimum is written for a person sitting
  /// still.
  static const double tapTarget = 56;

  /// Minimum tap target for secondary controls where 56 would dominate.
  /// Still above the platform floor.
  static const double tapTargetSmall = 48;
}

/// Corner radii.
///
/// Four values, and a deliberate refusal to round everything. The mandate
/// against "excessive rounded rectangles" is a real design point: when every
/// element has the same 16px radius, nothing has a shape, and the screen reads
/// as a pile of lozenges. Radius here signals *kind*: a control is [sm], a
/// container is [md], a sheet is [sheet], and only a genuinely pill-shaped
/// thing is [pill].
abstract final class AlyRadius {
  /// 6 — inputs, small chips.
  static const double sm = 6;

  /// 10 — buttons, cards, list rows.
  static const double md = 10;

  /// 16 — a container holding other containers.
  static const double lg = 16;

  /// 20 — the top corners of a bottom sheet, and nothing else.
  static const double sheet = 20;

  /// Fully round. Avatars, status dots, the online toggle.
  static const double pill = 999;
}

/// Elevation, expressed as shadows rather than as a number.
///
/// Material's `elevation: 4` means different things on different surfaces and
/// nothing at all in dark mode. These are explicit shadow sets, and dark mode
/// is expected to use surface luminance instead — [AlyElevation.none] is the
/// correct choice for a dark-mode sheet.
///
/// Four levels only. A product with seven elevations has no elevation: the
/// viewer cannot tell level 3 from level 4, so the extra levels carry no
/// information and only add inconsistency.
abstract final class AlyElevation {
  static const List<BoxShadow> none = [];

  /// A card resting on the background.
  static const List<BoxShadow> low = [
    BoxShadow(color: Color(0x0D111827), blurRadius: 2, offset: Offset(0, 1)),
    BoxShadow(color: Color(0x0A111827), blurRadius: 6, offset: Offset(0, 2)),
  ];

  /// A sheet over content, a sticky footer, a floating control on a map.
  static const List<BoxShadow> medium = [
    BoxShadow(color: Color(0x14111827), blurRadius: 4, offset: Offset(0, 2)),
    BoxShadow(color: Color(0x0F111827), blurRadius: 16, offset: Offset(0, 8)),
  ];

  /// A dialog. The only thing above it is the scrim.
  static const List<BoxShadow> high = [
    BoxShadow(color: Color(0x1A111827), blurRadius: 8, offset: Offset(0, 4)),
    BoxShadow(color: Color(0x14111827), blurRadius: 32, offset: Offset(0, 16)),
  ];
}

/// Motion.
///
/// ## The rule
///
/// Motion explains a change of state. If a movement does not tell the user
/// where something came from or where it went, it is decoration and it is
/// removed. There is no bouncing, no staggered entrance, no animated
/// illustration.
///
/// ## The durations
///
/// Fast, because this app is used in a hurry. 150ms for a control responding to
/// a touch — below that a transition reads as a glitch, above it as lag. 250ms
/// for something entering or leaving the screen. 400ms only for a full-screen
/// change, and even then the user is not waiting on it.
///
/// A driver has fifteen seconds to accept an offer. Every millisecond of
/// animation on that sheet is a millisecond taken from a decision.
abstract final class AlyMotion {
  /// A control acknowledging a press: colour, scale, ripple.
  static const Duration fast = Duration(milliseconds: 150);

  /// A sheet, a toast, an inline expansion.
  static const Duration medium = Duration(milliseconds: 250);

  /// A route transition.
  static const Duration slow = Duration(milliseconds: 400);

  /// One sweep of a skeleton shimmer.
  static const Duration shimmer = Duration(milliseconds: 1200);

  /// Entering: decelerate. Objects arrive and settle.
  static const Curve enter = Curves.easeOutCubic;

  /// Leaving: accelerate. Objects depart and are gone.
  static const Curve exit = Curves.easeInCubic;

  /// Moving within the screen.
  static const Curve standard = Curves.easeInOutCubic;

  /// A sheet being dragged and released. The one place a little overshoot is
  /// honest, because the sheet has physical momentum in the user's hand.
  static const Curve sheet = Curves.easeOutQuart;

  /// Honours the platform's reduce-motion setting.
  ///
  /// Not an accessibility afterthought: vestibular disorders make large motion
  /// genuinely unpleasant, and a user who has asked the OS for less of it has
  /// already told us. Returns [Duration.zero] so the end state still applies —
  /// disabling the animation, never the change.
  static Duration respecting(BuildContext context, Duration duration) =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false ? Duration.zero : duration;
}
