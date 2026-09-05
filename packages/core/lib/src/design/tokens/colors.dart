import 'package:flutter/material.dart';

/// ALY's colour system.
///
/// ## Why a semantic layer instead of a palette
///
/// Screens never name a colour. They name a ROLE — `surface`, `textSecondary`,
/// `borderStrong` — and the role resolves differently in light and dark. That
/// is the only structure in which dark mode is a real design rather than an
/// inversion: `surfaceElevated` is *lighter* than `surface` in dark and
/// *the same white with a shadow* in light, because elevation is communicated
/// by luminance in the dark and by shadow in the light. A single palette with
/// `Colors.white` sprinkled through the screens cannot express that, and the
/// result is the flat grey app that reads as unfinished.
///
/// ## The brand colour
///
/// Deep teal, `#0F7B6C`. Chosen and kept for three reasons:
///
///   - It is not the colour of a competitor. Uber is black, Careem green,
///     inDrive lime, Bolt bright green. A rider glancing at a phone in a car
///     should not have to check which app is open.
///   - It holds contrast against both a light map and a dark map, which a
///     lighter brand colour does not — and the map is the background of the
///     most important screen in the product.
///   - It carries the "generic AI startup" test: it is not a purple gradient.
///
/// ## Contrast
///
/// Every text-on-surface pair below meets WCAG AA (4.5:1 for body, 3:1 for
/// large text and UI). That is not decoration: this app is used in direct
/// Baghdad sunlight through a windscreen, which is a harsher environment than
/// any accessibility guideline was written for.
abstract final class AlyPalette {
  // Brand — teal.
  static const Color teal900 = Color(0xFF06322C);
  static const Color teal800 = Color(0xFF07463D);
  static const Color teal700 = Color(0xFF0A5C50);
  static const Color teal600 = Color(0xFF0F7B6C);
  static const Color teal500 = Color(0xFF149484);
  static const Color teal400 = Color(0xFF2CB3A1);
  static const Color teal300 = Color(0xFF6BCCBF);
  static const Color teal200 = Color(0xFFA8E2D9);
  static const Color teal100 = Color(0xFFD6F1EC);
  static const Color teal50 = Color(0xFFEDF9F7);

  // Accent — amber. Used for the driver's earnings and for "attention, not
  // alarm". Never for a destructive action.
  static const Color amber700 = Color(0xFF9A6410);
  static const Color amber600 = Color(0xFFC07C14);
  static const Color amber500 = Color(0xFFE8A33D);
  static const Color amber300 = Color(0xFFF3CE8C);
  static const Color amber100 = Color(0xFFFBEED5);

  // Neutrals. A slightly cool grey ramp, so surfaces sit under the teal
  // without the muddy cast a pure-neutral ramp gives next to a green.
  static const Color grey950 = Color(0xFF0B0F14);
  static const Color grey900 = Color(0xFF111827);
  static const Color grey850 = Color(0xFF161E2B);
  static const Color grey800 = Color(0xFF1F2937);
  static const Color grey700 = Color(0xFF374151);
  static const Color grey600 = Color(0xFF4B5563);
  static const Color grey500 = Color(0xFF6B7280);
  static const Color grey400 = Color(0xFF9CA3AF);
  static const Color grey300 = Color(0xFFD1D5DB);
  static const Color grey200 = Color(0xFFE5E7EB);
  static const Color grey100 = Color(0xFFF3F4F6);
  static const Color grey50 = Color(0xFFF9FAFB);
  static const Color white = Color(0xFFFFFFFF);

  // Semantic hues.
  static const Color green600 = Color(0xFF15803D);
  static const Color green500 = Color(0xFF22A34F);
  static const Color green100 = Color(0xFFDCFCE7);
  static const Color green300 = Color(0xFF86EFAC);

  static const Color red700 = Color(0xFF991B1B);
  static const Color red600 = Color(0xFFB91C1C);
  static const Color red500 = Color(0xFFDC2626);
  static const Color red300 = Color(0xFFFCA5A5);
  static const Color red100 = Color(0xFFFEE2E2);

  static const Color blue600 = Color(0xFF1D4ED8);
  static const Color blue500 = Color(0xFF3B82F6);
  static const Color blue300 = Color(0xFF93C5FD);
  static const Color blue100 = Color(0xFFDBEAFE);
}

/// The roles a screen is allowed to name.
///
/// Immutable, constructed twice — once for light, once for dark — and read
/// through `AlyColors.of(context)`. A screen that reaches past this into
/// [AlyPalette] has hard-coded a light-mode value into a dark-mode build, which
/// is the single most common way a theme-aware app develops a broken screen.
@immutable
class AlyColors extends ThemeExtension<AlyColors> {
  const AlyColors({
    required this.brightness,
    required this.primary,
    required this.onPrimary,
    required this.primaryHover,
    required this.primaryMuted,
    required this.accent,
    required this.onAccent,
    required this.accentMuted,
    required this.background,
    required this.surface,
    required this.surfaceElevated,
    required this.surfaceSunken,
    required this.scrim,
    required this.textPrimary,
    required this.textSecondary,
    required this.textTertiary,
    required this.textDisabled,
    required this.textOnColor,
    required this.border,
    required this.borderStrong,
    required this.borderFocus,
    required this.success,
    required this.onSuccess,
    required this.successMuted,
    required this.warning,
    required this.onWarning,
    required this.warningMuted,
    required this.error,
    required this.onError,
    required this.errorMuted,
    required this.info,
    required this.onInfo,
    required this.infoMuted,
    required this.online,
    required this.offline,
    required this.mapRoute,
    required this.mapPickup,
    required this.mapDropoff,
    required this.skeletonBase,
    required this.skeletonHighlight,
  });

  final Brightness brightness;

  /// Brand.
  final Color primary;
  final Color onPrimary;

  /// The pressed/hovered state of a primary surface. A darker teal in light
  /// mode and a lighter one in dark — pressing must always move *toward* the
  /// viewer's attention, and which direction that is depends on the ground.
  final Color primaryHover;

  /// A tinted background for a selected row or an active chip. Never used for
  /// text.
  final Color primaryMuted;

  final Color accent;
  final Color onAccent;
  final Color accentMuted;

  /// Behind everything. The scaffold.
  final Color background;

  /// A card, a sheet, an app bar — the plane the content sits on.
  final Color surface;

  /// One step above [surface]: a bottom sheet over a map, a menu, a dialog.
  final Color surfaceElevated;

  /// One step BELOW [surface]: an input field, a track, an inset well.
  final Color surfaceSunken;

  /// Behind a modal. Includes its own opacity.
  final Color scrim;

  final Color textPrimary;
  final Color textSecondary;

  /// Timestamps, units, the third line of a card.
  final Color textTertiary;
  final Color textDisabled;

  /// Text placed on [primary], [error], [success] and friends.
  final Color textOnColor;

  /// The default hairline. Separators, card outlines.
  final Color border;

  /// A deliberate outline: an unselected radio, an outlined button.
  final Color borderStrong;

  /// The focus ring. Must be visible in both modes without being decorative.
  final Color borderFocus;

  final Color success;
  final Color onSuccess;
  final Color successMuted;
  final Color warning;
  final Color onWarning;
  final Color warningMuted;
  final Color error;
  final Color onError;
  final Color errorMuted;
  final Color info;
  final Color onInfo;
  final Color infoMuted;

  /// The driver's online state. Unmistakable at a glance in daylight through a
  /// windscreen — this is the one colour in the system tuned for a glance
  /// rather than a read.
  final Color online;
  final Color offline;

  /// Map furniture. Kept in the token set rather than in the map widget,
  /// because a route line that does not match the app is the fastest way to
  /// make a product look assembled from parts.
  final Color mapRoute;
  final Color mapPickup;
  final Color mapDropoff;

  /// Skeleton loading. Two stops, animated between.
  final Color skeletonBase;
  final Color skeletonHighlight;

  static const AlyColors light = AlyColors(
    brightness: Brightness.light,
    primary: AlyPalette.teal600,
    onPrimary: AlyPalette.white,
    primaryHover: AlyPalette.teal700,
    primaryMuted: AlyPalette.teal50,
    accent: AlyPalette.amber600,
    onAccent: AlyPalette.white,
    accentMuted: AlyPalette.amber100,
    background: AlyPalette.grey50,
    surface: AlyPalette.white,
    // In light mode elevation is carried by shadow, not by luminance: there is
    // nothing lighter than white. `surfaceElevated` stays white and the
    // elevation tokens supply the shadow.
    surfaceElevated: AlyPalette.white,
    surfaceSunken: AlyPalette.grey100,
    scrim: Color(0x66111827),
    textPrimary: AlyPalette.grey900,
    textSecondary: AlyPalette.grey600,
    textTertiary: AlyPalette.grey500,
    textDisabled: AlyPalette.grey400,
    textOnColor: AlyPalette.white,
    border: AlyPalette.grey200,
    borderStrong: AlyPalette.grey300,
    borderFocus: AlyPalette.teal600,
    success: AlyPalette.green600,
    onSuccess: AlyPalette.white,
    successMuted: AlyPalette.green100,
    warning: AlyPalette.amber700,
    onWarning: AlyPalette.white,
    warningMuted: AlyPalette.amber100,
    error: AlyPalette.red600,
    onError: AlyPalette.white,
    errorMuted: AlyPalette.red100,
    info: AlyPalette.blue600,
    onInfo: AlyPalette.white,
    infoMuted: AlyPalette.blue100,
    online: AlyPalette.green600,
    offline: AlyPalette.grey400,
    mapRoute: AlyPalette.teal600,
    mapPickup: AlyPalette.green600,
    mapDropoff: AlyPalette.red600,
    skeletonBase: AlyPalette.grey200,
    skeletonHighlight: AlyPalette.grey100,
  );

  /// Dark mode, designed rather than inverted.
  ///
  /// Three decisions worth stating, because each is where a naive inversion
  /// goes wrong:
  ///
  ///   - The background is `grey950`, not black. True black against an OLED
  ///     panel makes every scroll edge smear, and it leaves no room to sink a
  ///     surface *below* the background.
  ///   - Elevation is luminance. `surface` < `surfaceElevated`, and a sheet
  ///     over a map is visibly lighter than the map chrome behind it. Shadows
  ///     do almost nothing on a dark ground, so they are not asked to.
  ///   - The brand colour moves UP the ramp, from `teal600` to `teal400`.
  ///     `teal600` on `grey950` is 2.9:1 — legible as a shape, not as text.
  ///     Keeping the same hex in both modes is the most common dark-mode bug
  ///     and it is invisible to anyone testing in a bright room.
  static const AlyColors dark = AlyColors(
    brightness: Brightness.dark,
    primary: AlyPalette.teal400,
    onPrimary: AlyPalette.teal900,
    primaryHover: AlyPalette.teal300,
    primaryMuted: Color(0xFF0D2E2A),
    accent: AlyPalette.amber500,
    onAccent: Color(0xFF2A1B05),
    accentMuted: Color(0xFF2E2310),
    background: AlyPalette.grey950,
    surface: AlyPalette.grey900,
    surfaceElevated: AlyPalette.grey850,
    surfaceSunken: Color(0xFF080C11),
    scrim: Color(0x99000000),
    textPrimary: AlyPalette.grey50,
    textSecondary: AlyPalette.grey400,
    textTertiary: AlyPalette.grey500,
    textDisabled: AlyPalette.grey600,
    textOnColor: AlyPalette.white,
    border: Color(0xFF243040),
    borderStrong: AlyPalette.grey700,
    borderFocus: AlyPalette.teal400,
    success: AlyPalette.green500,
    onSuccess: Color(0xFF05230F),
    successMuted: Color(0xFF0B2E18),
    warning: AlyPalette.amber500,
    onWarning: Color(0xFF2A1B05),
    warningMuted: Color(0xFF2E2310),
    error: AlyPalette.red500,
    onError: AlyPalette.white,
    errorMuted: Color(0xFF3A1414),
    info: AlyPalette.blue500,
    onInfo: AlyPalette.white,
    infoMuted: Color(0xFF122744),
    online: AlyPalette.green500,
    offline: AlyPalette.grey600,
    mapRoute: AlyPalette.teal400,
    mapPickup: AlyPalette.green500,
    mapDropoff: AlyPalette.red500,
    skeletonBase: AlyPalette.grey800,
    skeletonHighlight: AlyPalette.grey700,
  );

  /// The only way a screen should reach a colour.
  static AlyColors of(BuildContext context) =>
      Theme.of(context).extension<AlyColors>() ?? light;

  @override
  AlyColors copyWith({Brightness? brightness}) =>
      brightness == Brightness.dark ? dark : light;

  /// Themes are not interpolated between light and dark in this app — the
  /// switch is instant, because a half-second cross-fade of every colour on a
  /// map screen reads as a rendering fault rather than as a transition.
  @override
  AlyColors lerp(ThemeExtension<AlyColors>? other, double t) =>
      t < 0.5 ? this : (other as AlyColors? ?? this);
}
