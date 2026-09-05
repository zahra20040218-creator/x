import 'package:flutter/material.dart';

/// The shared design system.
///
/// CLAUDE.md §1: "Duplicated widget code between rider and driver is a defect."
/// Both apps import this, so a spacing or colour change lands in both.
///
/// RTL is the default (CLAUDE.md §8). Layouts use `EdgeInsetsDirectional` and
/// `start`/`end` rather than `left`/`right`, so the same widget mirrors
/// correctly in English without a second code path.
abstract class AppColors {
  static const Color primary = Color(0xFF0F7B6C);
  static const Color primaryDark = Color(0xFF0A5C50);
  static const Color accent = Color(0xFFE8A33D);

  static const Color surface = Color(0xFFFFFFFF);
  static const Color background = Color(0xFFF6F7F9);
  static const Color surfaceVariant = Color(0xFFEDF0F3);

  static const Color textPrimary = Color(0xFF111827);
  static const Color textSecondary = Color(0xFF6B7280);
  static const Color divider = Color(0xFFE5E7EB);

  static const Color success = Color(0xFF15803D);
  static const Color warning = Color(0xFFB45309);
  static const Color danger = Color(0xFFB91C1C);

  /// The driver's online indicator. Deliberately unmistakable at a glance in
  /// daylight through a windscreen.
  static const Color online = Color(0xFF15803D);
  static const Color offline = Color(0xFF9CA3AF);
}

abstract class AppSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;

  /// Minimum tap target. A driver taps "accept" one-handed, in a moving car,
  /// against a 15-second deadline - 56 rather than the platform minimum of 48.
  static const double tapTarget = 56;
}

abstract class AppRadius {
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 20;
  static const double sheet = 24;
}

abstract class AppTheme {
  /// Arabic text needs a font with proper shaping. Cairo and Tajawal both do;
  /// the fallback chain matters because a missing Arabic glyph renders as a box
  /// and makes the app look broken rather than untranslated.
  static const String fontFamily = 'Cairo';
  static const List<String> fontFallback = ['Tajawal', 'Noto Sans Arabic'];

  static ThemeData light() {
    final base = ThemeData.light(useMaterial3: true);

    return base.copyWith(
      colorScheme: base.colorScheme.copyWith(
        primary: AppColors.primary,
        secondary: AppColors.accent,
        surface: AppColors.surface,
        error: AppColors.danger,
      ),
      scaffoldBackgroundColor: AppColors.background,
      dividerColor: AppColors.divider,
      textTheme: _textTheme(base.textTheme),
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.surface,
        foregroundColor: AppColors.textPrimary,
        elevation: 0,
        centerTitle: true,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(AppSpacing.tapTarget),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.md),
          ),
          textStyle: const TextStyle(
            fontFamily: fontFamily,
            fontSize: 17,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.textPrimary,
          minimumSize: const Size.fromHeight(AppSpacing.tapTarget),
          side: const BorderSide(color: AppColors.divider),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.md),
          ),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surfaceVariant,
        contentPadding: const EdgeInsetsDirectional.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.md,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          borderSide: BorderSide.none,
        ),
      ),
      cardTheme: CardThemeData(
        color: AppColors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.md),
          side: const BorderSide(color: AppColors.divider),
        ),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: AppColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(AppRadius.sheet),
          ),
        ),
      ),
    );
  }

  static TextTheme _textTheme(TextTheme base) => base
      .apply(
        fontFamily: fontFamily,
        bodyColor: AppColors.textPrimary,
        displayColor: AppColors.textPrimary,
      )
      .copyWith(
        // The fare is the number both parties argue about. It gets the largest
        // type on the screen, and tabular figures so digits do not shift as it
        // updates.
        headlineMedium: const TextStyle(
          fontFamily: fontFamily,
          // Every style replaced here must restate the colour: `.copyWith`
          // overwrites the style wholesale, so a style built without one
          // discards what `.apply(bodyColor:)` set above and renders invisible.
          color: AppColors.textPrimary,
          fontSize: 28,
          fontWeight: FontWeight.w700,
          fontFeatures: [FontFeature.tabularFigures()],
        ),
        titleLarge: const TextStyle(
          fontFamily: fontFamily,
          color: AppColors.textPrimary,
          fontSize: 20,
          fontWeight: FontWeight.w600,
        ),
        bodyMedium: const TextStyle(
          fontFamily: fontFamily,
          color: AppColors.textPrimary,
          fontSize: 15,
        ),
        labelLarge: const TextStyle(
          fontFamily: fontFamily,
          color: AppColors.textPrimary,
          fontSize: 16,
          fontWeight: FontWeight.w600,
        ),
      );
}
