import 'package:flutter/material.dart';
import 'package:rideapp_core/src/design/tokens/colors.dart';
import 'package:rideapp_core/src/design/tokens/metrics.dart';
import 'package:rideapp_core/src/design/tokens/typography.dart';

/// How much weight a button carries on the screen.
///
/// The hierarchy is the point. A screen has ONE [primary] — the thing the user
/// came to do. Everything else is [secondary] or [tertiary]. Two primary
/// buttons side by side is not a choice offered to the user, it is a decision
/// the designer declined to make, and the user pays for it by having to read
/// both.
enum AlyButtonVariant {
  /// Filled, brand colour. One per screen.
  primary,

  /// Outlined. An alternative the user might reasonably take.
  secondary,

  /// Text only. A way out, a "not now", a link.
  tertiary,

  /// Filled, red. Cancel a ride, delete an account. Never the default focus.
  danger,
}

enum AlyButtonSize {
  /// 56pt. The default, and the only size for a primary action.
  large,

  /// 48pt. Inside a card or a row, where 56 would dominate.
  medium,
}

/// The button.
///
/// ## Every state, because a button is not a rectangle
///
/// | State | What changes |
/// |---|---|
/// | default | — |
/// | pressed | fill darkens (light) or lightens (dark), and it scales to 0.98 |
/// | focused | a 2pt focus ring outside the shape |
/// | disabled | fill drops to `surfaceSunken`, label to `textDisabled` |
/// | loading | a spinner replaces the label, the WIDTH DOES NOT CHANGE |
///
/// The width not changing during loading is the detail that matters most and is
/// most often missed. A button that shrinks to a spinner moves everything
/// around it, and on a confirmation screen it moves the thing the user is about
/// to tap. So the label stays laid out and is made invisible, and the spinner
/// sits on top of it.
///
/// ## Loading implies disabled
///
/// A loading button does not accept a second press. That is enforced here
/// rather than left to each caller, because "the user double-tapped confirm" is
/// how a rider ends up with two rides — the exact failure CLAUDE.md §5.2 has an
/// idempotency key to catch on the server. The client should not be relying on
/// that catch.
class AlyButton extends StatefulWidget {
  const AlyButton({
    required this.label,
    required this.onPressed,
    super.key,
    this.variant = AlyButtonVariant.primary,
    this.size = AlyButtonSize.large,
    this.icon,
    this.isLoading = false,
    this.expand = true,
    this.semanticLabel,
  });

  /// Convenience for the common case.
  const AlyButton.secondary({
    required this.label,
    required this.onPressed,
    super.key,
    this.size = AlyButtonSize.large,
    this.icon,
    this.isLoading = false,
    this.expand = true,
    this.semanticLabel,
  }) : variant = AlyButtonVariant.secondary;

  const AlyButton.danger({
    required this.label,
    required this.onPressed,
    super.key,
    this.size = AlyButtonSize.large,
    this.icon,
    this.isLoading = false,
    this.expand = true,
    this.semanticLabel,
  }) : variant = AlyButtonVariant.danger;

  final String label;

  /// Null disables the button. There is no separate `enabled` flag: two ways to
  /// disable one control is one way too many, and they eventually disagree.
  final VoidCallback? onPressed;

  final AlyButtonVariant variant;
  final AlyButtonSize size;

  /// Leading icon. Sits at the START edge, so it mirrors in RTL without a
  /// second code path.
  final IconData? icon;

  final bool isLoading;

  /// Fill the available width. True for a primary action at the bottom of a
  /// screen; false inside a row.
  final bool expand;

  /// For screen readers, when the visible label is not the whole story —
  /// "Accept" on an offer sheet should announce the fare too.
  final String? semanticLabel;

  @override
  State<AlyButton> createState() => _AlyButtonState();
}

class _AlyButtonState extends State<AlyButton> {
  bool _pressed = false;

  bool get _enabled => widget.onPressed != null && !widget.isLoading;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final height = widget.size == AlyButtonSize.large
        ? AlySpacing.tapTarget
        : AlySpacing.tapTargetSmall;

    final (background, foreground, border) = _resolve(c);

    final content = Stack(
      alignment: Alignment.center,
      children: [
        // Laid out even while loading, so the button keeps its width. Opacity,
        // not Visibility: `Visibility` removes it from layout and the button
        // collapses onto the spinner.
        Opacity(
          opacity: widget.isLoading ? 0 : 1,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (widget.icon != null) ...[
                Icon(widget.icon, size: 20, color: foreground),
                const SizedBox(width: AlySpacing.sm),
              ],
              Flexible(
                child: Text(
                  widget.label,
                  style: AlyTypography.button.copyWith(color: foreground),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                ),
              ),
            ],
          ),
        ),
        if (widget.isLoading)
          SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2.2, color: foreground),
          ),
      ],
    );

    return Semantics(
      button: true,
      enabled: _enabled,
      label: widget.semanticLabel ?? widget.label,
      // Announced so a screen-reader user is told why nothing happened, rather
      // than being left to wonder.
      hint: widget.isLoading ? 'جارٍ التنفيذ' : null,
      child: GestureDetector(
        onTapDown: _enabled ? (_) => setState(() => _pressed = true) : null,
        onTapUp: _enabled ? (_) => setState(() => _pressed = false) : null,
        onTapCancel: _enabled ? () => setState(() => _pressed = false) : null,
        onTap: _enabled ? widget.onPressed : null,
        child: AnimatedScale(
          // 0.98, not 0.95. Large enough to feel, small enough that a button at
          // the bottom of a sheet does not appear to jump away from the thumb.
          scale: _pressed ? 0.98 : 1,
          duration: AlyMotion.respecting(context, AlyMotion.fast),
          curve: AlyMotion.standard,
          child: AnimatedContainer(
            duration: AlyMotion.respecting(context, AlyMotion.fast),
            height: height,
            width: widget.expand ? double.infinity : null,
            padding: EdgeInsetsDirectional.symmetric(
              horizontal: widget.expand ? AlySpacing.lg : AlySpacing.xl,
            ),
            decoration: BoxDecoration(
              color: background,
              borderRadius: BorderRadius.circular(AlyRadius.md),
              border: border == null ? null : Border.fromBorderSide(border),
            ),
            alignment: Alignment.center,
            child: content,
          ),
        ),
      ),
    );
  }

  (Color background, Color foreground, BorderSide? border) _resolve(AlyColors c) {
    if (!_enabled) {
      return (
        widget.variant == AlyButtonVariant.tertiary ? Colors.transparent : c.surfaceSunken,
        c.textDisabled,
        widget.variant == AlyButtonVariant.secondary ? BorderSide(color: c.border) : null,
      );
    }

    return switch (widget.variant) {
      AlyButtonVariant.primary => (
        _pressed ? c.primaryHover : c.primary,
        c.onPrimary,
        null,
      ),
      AlyButtonVariant.secondary => (
        _pressed ? c.surfaceSunken : Colors.transparent,
        c.textPrimary,
        BorderSide(color: c.borderStrong),
      ),
      AlyButtonVariant.tertiary => (
        _pressed ? c.surfaceSunken : Colors.transparent,
        c.primary,
        null,
      ),
      AlyButtonVariant.danger => (
        _pressed ? c.errorMuted : c.error,
        _pressed ? c.error : c.onError,
        null,
      ),
    };
  }
}

/// A square, icon-only control.
///
/// Map controls, a close button on a sheet, a back arrow. Always at least
/// [AlySpacing.tapTargetSmall] even when the icon is 20pt — the touch target
/// and the visual size are different measurements, and conflating them is why
/// small icon buttons are so often un-tappable.
class AlyIconButton extends StatelessWidget {
  const AlyIconButton({
    required this.icon,
    required this.onPressed,
    required this.semanticLabel,
    super.key,
    this.filled = false,
    this.tone,
  });

  final IconData icon;
  final VoidCallback? onPressed;

  /// Required, not optional. An icon-only control is invisible to a screen
  /// reader without it, and making it optional means it will be omitted.
  final String semanticLabel;

  /// A surface behind the icon. Used when the button sits over a map, where a
  /// bare icon would disappear against the imagery.
  final bool filled;

  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final enabled = onPressed != null;
    final foreground = enabled ? (tone ?? c.textPrimary) : c.textDisabled;

    return Semantics(
      button: true,
      enabled: enabled,
      label: semanticLabel,
      child: Material(
        color: filled ? c.surfaceElevated : Colors.transparent,
        shape: filled
            ? RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(AlyRadius.md),
                side: BorderSide(color: c.border),
              )
            : const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onPressed,
          child: SizedBox(
            width: AlySpacing.tapTargetSmall,
            height: AlySpacing.tapTargetSmall,
            child: Icon(icon, size: 22, color: foreground),
          ),
        ),
      ),
    );
  }
}
