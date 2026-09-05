import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';
import 'package:rideapp_core/src/design/tokens/colors.dart';
import 'package:rideapp_core/src/design/tokens/metrics.dart';
import 'package:rideapp_core/src/design/tokens/typography.dart';

/// The ALY theme.
///
/// Composes the token files into a `ThemeData` and attaches [AlyColors] as a
/// theme extension so screens can reach roles that Material has no slot for —
/// `surfaceSunken`, `online`, `mapRoute`, `skeletonBase`.
///
/// ## Why every Material component theme is configured
///
/// A component left at Material's default is a component nobody designed. It
/// will render — that is the trap — with Material's radius, Material's
/// elevation and Roboto, next to components that have all three from ALY. That
/// mismatch is what makes an app read as assembled rather than designed, and it
/// arrives one unconfigured widget at a time.
abstract final class AlyTheme {
  static ThemeData light() => _build(AlyColors.light);
  static ThemeData dark() => _build(AlyColors.dark);

  static ThemeData _build(AlyColors c) {
    final isDark = c.brightness == Brightness.dark;
    final base = isDark
        ? ThemeData.dark(useMaterial3: true)
        : ThemeData.light(useMaterial3: true);

    final textTheme = AlyTypography.textTheme(c.textPrimary, c.textSecondary);

    return base.copyWith(
      brightness: c.brightness,
      extensions: <ThemeExtension<dynamic>>[c],

      colorScheme: base.colorScheme.copyWith(
        brightness: c.brightness,
        primary: c.primary,
        onPrimary: c.onPrimary,
        secondary: c.accent,
        onSecondary: c.onAccent,
        surface: c.surface,
        onSurface: c.textPrimary,
        surfaceContainerHighest: c.surfaceSunken,
        error: c.error,
        onError: c.onError,
        outline: c.border,
        outlineVariant: c.borderStrong,
      ),

      scaffoldBackgroundColor: c.background,
      canvasColor: c.surface,
      dividerColor: c.border,
      splashFactory: InkSparkle.splashFactory,
      textTheme: textTheme,
      primaryTextTheme: textTheme,

      dividerTheme: DividerThemeData(color: c.border, thickness: 1, space: 1),

      appBarTheme: AppBarTheme(
        backgroundColor: c.surface,
        foregroundColor: c.textPrimary,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: true,
        titleTextStyle: AlyTypography.title.copyWith(color: c.textPrimary),
      ),

      // Filled, primary. One per screen.
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ButtonStyle(
          backgroundColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.disabled)) return c.surfaceSunken;
            if (states.contains(WidgetState.pressed)) return c.primaryHover;
            return c.primary;
          }),
          foregroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.disabled) ? c.textDisabled : c.onPrimary,
          ),
          // Explicitly zero. Elevation on a filled button is a Material 2 habit
          // that reads as a floating slab against a flat design.
          elevation: const WidgetStatePropertyAll(0),
          minimumSize: const WidgetStatePropertyAll(
            Size.fromHeight(AlySpacing.tapTarget),
          ),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(AlyRadius.md)),
          ),
          textStyle: WidgetStatePropertyAll(AlyTypography.button),
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: ButtonStyle(
          foregroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.disabled) ? c.textDisabled : c.textPrimary,
          ),
          side: WidgetStateProperty.resolveWith(
            (states) => BorderSide(
              color: states.contains(WidgetState.disabled) ? c.border : c.borderStrong,
            ),
          ),
          minimumSize: const WidgetStatePropertyAll(
            Size.fromHeight(AlySpacing.tapTarget),
          ),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(AlyRadius.md)),
          ),
          textStyle: WidgetStatePropertyAll(AlyTypography.button),
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: ButtonStyle(
          foregroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.disabled) ? c.textDisabled : c.primary,
          ),
          minimumSize: const WidgetStatePropertyAll(
            Size(0, AlySpacing.tapTargetSmall),
          ),
          textStyle: WidgetStatePropertyAll(AlyTypography.button),
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: c.surfaceSunken,
        contentPadding: const EdgeInsetsDirectional.symmetric(
          horizontal: AlySpacing.lg,
          vertical: AlySpacing.lg,
        ),
        hintStyle: AlyTypography.body.copyWith(color: c.textTertiary),
        labelStyle: AlyTypography.body.copyWith(color: c.textSecondary),
        floatingLabelStyle: AlyTypography.label.copyWith(color: c.primary),
        errorStyle: AlyTypography.bodySmall.copyWith(color: c.error),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AlyRadius.sm),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AlyRadius.sm),
          borderSide: BorderSide.none,
        ),
        // A visible focus ring, in both modes. The default Material underline
        // disappears against a filled field and leaves keyboard users with no
        // idea where they are.
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AlyRadius.sm),
          borderSide: BorderSide(color: c.borderFocus, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AlyRadius.sm),
          borderSide: BorderSide(color: c.error, width: 1.5),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AlyRadius.sm),
          borderSide: BorderSide(color: c.error, width: 2),
        ),
      ),

      cardTheme: CardThemeData(
        color: c.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AlyRadius.md),
          side: BorderSide(color: c.border),
        ),
      ),

      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: c.surfaceElevated,
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: c.surfaceElevated,
        elevation: 0,
        showDragHandle: true,
        dragHandleColor: c.borderStrong,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(AlyRadius.sheet)),
        ),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: c.surfaceElevated,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AlyRadius.lg),
        ),
        titleTextStyle: AlyTypography.h3.copyWith(color: c.textPrimary),
        contentTextStyle: AlyTypography.body.copyWith(color: c.textSecondary),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: isDark ? c.surfaceElevated : AlyPalette.grey900,
        contentTextStyle: AlyTypography.body.copyWith(color: AlyPalette.white),
        actionTextColor: c.primary,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AlyRadius.md),
        ),
      ),

      chipTheme: ChipThemeData(
        backgroundColor: c.surfaceSunken,
        selectedColor: c.primaryMuted,
        labelStyle: AlyTypography.bodySmall.copyWith(color: c.textPrimary),
        side: BorderSide(color: c.border),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AlyRadius.sm),
        ),
        padding: const EdgeInsets.symmetric(
          horizontal: AlySpacing.md,
          vertical: AlySpacing.sm,
        ),
      ),

      listTileTheme: ListTileThemeData(
        iconColor: c.textSecondary,
        textColor: c.textPrimary,
        titleTextStyle: AlyTypography.bodyLarge.copyWith(color: c.textPrimary),
        subtitleTextStyle: AlyTypography.bodySmall.copyWith(color: c.textSecondary),
        contentPadding: const EdgeInsetsDirectional.symmetric(
          horizontal: AlySpacing.lg,
          vertical: AlySpacing.xs,
        ),
        minVerticalPadding: AlySpacing.md,
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? c.onPrimary : c.surface,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? c.primary : c.borderStrong,
        ),
        trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
      ),

      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: c.primary,
        linearTrackColor: c.surfaceSunken,
        circularTrackColor: c.surfaceSunken,
      ),

      iconTheme: IconThemeData(color: c.textSecondary, size: 22),

      // Motion. Material's default page transition is a platform-specific
      // slide; ALY uses one transition on both platforms so a screenshot from
      // an iPhone and one from an Android look like the same product.
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: FadeUpwardsPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        },
      ),
    );
  }
}
