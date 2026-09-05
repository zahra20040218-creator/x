import 'package:flutter/material.dart';

/// ALY's type scale.
///
/// ## Why a fixed scale
///
/// Eleven styles, and a screen may use no size that is not one of them. The
/// alternative — `fontSize: 17` here, `18` there — is the thing that separates
/// a product from a project, and it is invisible in any single screenshot. It
/// only shows when two screens sit next to each other.
///
/// The ramp is roughly a 1.2 minor third from `body` (15) outward, rounded to
/// whole pixels: 11 · 12 · 13 · 15 · 17 · 20 · 24 · 28 · 34. Whole pixels
/// because Arabic glyph shaping at fractional sizes produces visibly uneven
/// stem weights on Android.
///
/// ## Arabic first
///
/// Cairo, with Tajawal and Noto Sans Arabic behind it. Arabic needs a font that
/// actually shapes — a missing glyph renders as a box, which makes the app look
/// broken rather than untranslated. The fallback chain is not optional.
///
/// Line heights are looser than a Latin-only scale would use. Arabic has deep
/// descenders and stacked diacritics; 1.25 leading that looks generous in
/// English clips a kasra in Arabic.
///
/// ## Tabular figures on money and time
///
/// Any style that can hold a fare, a distance, an ETA or a countdown uses
/// [FontFeature.tabularFigures]. Without it the digits have different widths
/// and a number that updates once a second visibly jitters — on the one screen
/// where both parties are staring at the number.
abstract final class AlyTypography {
  static const String fontFamily = 'Cairo';
  static const List<String> fontFamilyFallback = ['Tajawal', 'Noto Sans Arabic'];

  static const List<FontFeature> _tabular = [FontFeature.tabularFigures()];

  static TextStyle _style({
    required double size,
    required FontWeight weight,
    required double height,
    double letterSpacing = 0,
    bool tabular = false,
  }) => TextStyle(
    fontFamily: fontFamily,
    fontFamilyFallback: fontFamilyFallback,
    fontSize: size,
    fontWeight: weight,
    // Flutter's `height` is a multiple of font size, so this is leading.
    height: height,
    letterSpacing: letterSpacing,
    fontFeatures: tabular ? _tabular : null,
  );

  /// The fare, and nothing else. One per screen, at most.
  static final TextStyle display = _style(
    size: 34,
    weight: FontWeight.w700,
    height: 1.20,
    letterSpacing: -0.5,
    tabular: true,
  );

  /// Screen title where there is no app bar.
  static final TextStyle h1 = _style(
    size: 28,
    weight: FontWeight.w700,
    height: 1.25,
    letterSpacing: -0.3,
  );

  /// Section heading.
  static final TextStyle h2 = _style(size: 24, weight: FontWeight.w700, height: 1.30);

  /// Card heading, sheet heading.
  static final TextStyle h3 = _style(size: 20, weight: FontWeight.w600, height: 1.35);

  /// App bar title, list group header.
  static final TextStyle title = _style(size: 17, weight: FontWeight.w600, height: 1.40);

  /// Lead paragraph, the primary line of a list row.
  static final TextStyle bodyLarge = _style(size: 17, weight: FontWeight.w400, height: 1.50);

  /// The default. Everything not otherwise specified.
  static final TextStyle body = _style(size: 15, weight: FontWeight.w400, height: 1.55);

  /// Supporting line under a body line.
  static final TextStyle bodySmall = _style(size: 13, weight: FontWeight.w400, height: 1.50);

  /// Timestamps, units, legal text. Never for anything a user must act on.
  static final TextStyle caption = _style(size: 12, weight: FontWeight.w400, height: 1.45);

  /// Field labels, chips, tags. Uppercase is NOT applied — Arabic has no case,
  /// and an uppercase-transformed label is simply an English-only design.
  static final TextStyle label = _style(
    size: 12,
    weight: FontWeight.w600,
    height: 1.35,
    letterSpacing: 0.2,
  );

  /// Button text. Its own style because it is optically centred in a fixed
  /// height and needs tighter leading than body at the same size.
  static final TextStyle button = _style(size: 16, weight: FontWeight.w600, height: 1.20);

  /// A number that changes while the user watches: ETA, countdown, distance,
  /// earnings ticking up. Tabular, so nothing shifts.
  static final TextStyle numeric = _style(
    size: 20,
    weight: FontWeight.w600,
    height: 1.30,
    tabular: true,
  );

  /// The same, small — inside a card or a row.
  static final TextStyle numericSmall = _style(
    size: 15,
    weight: FontWeight.w600,
    height: 1.35,
    tabular: true,
  );

  /// Maps the scale onto Material's slots so unstyled widgets inherit it.
  ///
  /// Every Material slot is filled. An unfilled slot silently falls back to
  /// Roboto at a size nobody chose — which is exactly the "random font sizes"
  /// this scale exists to prevent, arriving through the back door.
  static TextTheme textTheme(Color primary, Color secondary) {
    TextStyle on(TextStyle style, Color color) => style.copyWith(color: color);

    return TextTheme(
      displayLarge: on(display, primary),
      displayMedium: on(h1, primary),
      displaySmall: on(h2, primary),
      headlineLarge: on(h1, primary),
      headlineMedium: on(h2, primary),
      headlineSmall: on(h3, primary),
      titleLarge: on(h3, primary),
      titleMedium: on(title, primary),
      titleSmall: on(label, secondary),
      bodyLarge: on(bodyLarge, primary),
      bodyMedium: on(body, primary),
      bodySmall: on(bodySmall, secondary),
      labelLarge: on(button, primary),
      labelMedium: on(label, secondary),
      labelSmall: on(caption, secondary),
    );
  }
}
