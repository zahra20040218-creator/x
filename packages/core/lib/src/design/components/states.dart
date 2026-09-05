import 'package:flutter/material.dart';
import 'package:rideapp_core/src/design/components/buttons.dart';
import 'package:rideapp_core/src/design/tokens/colors.dart';
import 'package:rideapp_core/src/design/tokens/metrics.dart';
import 'package:rideapp_core/src/design/tokens/typography.dart';

/// Loading, empty and error — the three screens nobody designs.
///
/// A product is judged on these more than on its happy path, because the happy
/// path is what everyone builds. A white screen while data loads, and a bare
/// "Error occurred" when it fails, is the difference between a product and a
/// prototype — and both are what you get by default.
///
/// ## Microcopy
///
/// Every message here answers two questions: **what happened**, and **what do I
/// do now**. "حدث خطأ" answers neither. The copy is passed in by the caller
/// rather than defaulted, because a generic default is how every screen ends up
/// saying the same unhelpful thing.

/// A shimmering placeholder in the shape of the content that is coming.
///
/// Not a spinner. A spinner says "wait"; a skeleton says "wait, and here is
/// what you are waiting for", which makes the same delay feel shorter and stops
/// the layout jumping when content lands.
///
/// The shimmer sweeps from the START edge, so it runs right-to-left in Arabic
/// and left-to-right in English. A shimmer that always runs one way looks
/// backwards in the other language — a small thing that a native reader notices
/// immediately.
class AlySkeleton extends StatefulWidget {
  const AlySkeleton({
    super.key,
    this.width,
    this.height = 16,
    this.radius = AlyRadius.sm,
  });

  /// A circle, for an avatar placeholder.
  const AlySkeleton.circle({super.key, double size = 44})
      : width = size,
        height = size,
        radius = AlyRadius.pill;

  /// A line of text. Slightly shorter than full width by default, because real
  /// text rarely fills its line and a full-width bar reads as a divider.
  const AlySkeleton.line({super.key, this.width, this.height = 14})
      : radius = AlyRadius.sm;

  final double? width;
  final double height;
  final double radius;

  @override
  State<AlySkeleton> createState() => _AlySkeletonState();
}

class _AlySkeletonState extends State<AlySkeleton> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AlyMotion.shimmer,
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final rtl = Directionality.of(context) == TextDirection.rtl;

    // Reduce-motion turns the sweep off and leaves a flat block. The user still
    // sees the shape of what is coming; they are just not shown the animation
    // they asked not to see.
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) {
      return _block(c.skeletonBase);
    }

    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = _controller.value * 2 - 1;
        return ShaderMask(
          blendMode: BlendMode.srcATop,
          shaderCallback: (bounds) => LinearGradient(
            begin: Alignment(rtl ? 1 - t : -1 + t, 0),
            end: Alignment(rtl ? -1 - t : 1 + t, 0),
            colors: [c.skeletonBase, c.skeletonHighlight, c.skeletonBase],
            stops: const [0.35, 0.5, 0.65],
          ).createShader(bounds),
          child: _block(c.skeletonBase),
        );
      },
    );
  }

  Widget _block(Color color) => Container(
        width: widget.width,
        height: widget.height,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(widget.radius),
        ),
      );
}

/// A skeleton in the shape of a list row: avatar, two lines, a trailing value.
///
/// Provided as a named shape rather than left to each screen so that every list
/// in the product loads the same way. Inconsistent loading states are as
/// obvious as inconsistent buttons and are noticed less consciously.
class AlySkeletonRow extends StatelessWidget {
  const AlySkeletonRow({super.key, this.hasAvatar = true, this.hasTrailing = true});

  final bool hasAvatar;
  final bool hasTrailing;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsetsDirectional.symmetric(
          horizontal: AlySpacing.gutter,
          vertical: AlySpacing.md,
        ),
        child: Row(
          children: [
            if (hasAvatar) ...[
              const AlySkeleton.circle(),
              const SizedBox(width: AlySpacing.md),
            ],
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  AlySkeleton.line(width: 160),
                  SizedBox(height: AlySpacing.sm),
                  AlySkeleton.line(width: 100, height: 12),
                ],
              ),
            ),
            if (hasTrailing) ...[
              const SizedBox(width: AlySpacing.md),
              const AlySkeleton(width: 64, height: 18),
            ],
          ],
        ),
      );
}

/// Nothing here — and why, and what to do about it.
///
/// [title] says what is absent. [message] says why or what changes it. An
/// [actionLabel] with an [onAction] is offered only when there is genuinely
/// something the user can do; an empty state with a button that leads nowhere
/// is worse than one without.
///
/// No illustration. A decorative graphic in an empty state is the most common
/// piece of "generic AI UI" there is, it needs an asset per state, and it says
/// nothing. The icon is a single glyph from the system set at a restrained
/// size.
class AlyEmptyState extends StatelessWidget {
  const AlyEmptyState({
    required this.icon,
    required this.title,
    required this.message,
    super.key,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsetsDirectional.all(AlySpacing.xxl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Muted, not brand-coloured. An empty state is not an achievement
            // and colouring it draws the eye to the absence of content.
            Icon(icon, size: 40, color: c.textTertiary),
            const SizedBox(height: AlySpacing.lg),
            Text(
              title,
              style: AlyTypography.h3.copyWith(color: c.textPrimary),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AlySpacing.sm),
            Text(
              message,
              style: AlyTypography.body.copyWith(color: c.textSecondary),
              textAlign: TextAlign.center,
            ),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: AlySpacing.xl),
              AlyButton.secondary(
                label: actionLabel!,
                onPressed: onAction,
                expand: false,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Something failed, and the user can try again.
///
/// [message] must say what the user should do. The default is deliberately
/// about connectivity rather than "an error occurred", because on a Baghdad
/// mobile network that is what it usually is — and telling someone their
/// connection dropped is actionable in a way that "error" never is.
class AlyErrorState extends StatelessWidget {
  const AlyErrorState({
    required this.title,
    required this.message,
    required this.onRetry,
    super.key,
    this.retryLabel = 'إعادة المحاولة',
    this.icon = Icons.wifi_off_rounded,
  });

  final String title;
  final String message;
  final VoidCallback onRetry;
  final String retryLabel;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsetsDirectional.all(AlySpacing.xxl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(AlySpacing.md),
              decoration: BoxDecoration(
                color: c.errorMuted,
                borderRadius: BorderRadius.circular(AlyRadius.pill),
              ),
              child: Icon(icon, size: 28, color: c.error),
            ),
            const SizedBox(height: AlySpacing.lg),
            Text(
              title,
              style: AlyTypography.h3.copyWith(color: c.textPrimary),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AlySpacing.sm),
            Text(
              message,
              style: AlyTypography.body.copyWith(color: c.textSecondary),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AlySpacing.xl),
            AlyButton(
              label: retryLabel,
              onPressed: onRetry,
              icon: Icons.refresh_rounded,
              expand: false,
            ),
          ],
        ),
      ),
    );
  }
}

/// The connection is gone.
///
/// Distinct from [AlyErrorState] because it is not a failure of the request —
/// it is a state of the device, it will resolve on its own, and the user should
/// be told to wait rather than to retry. A persistent bar rather than a
/// full-screen takeover, so whatever is already on screen stays usable.
class AlyOfflineBanner extends StatelessWidget {
  const AlyOfflineBanner({
    super.key,
    this.message = 'لا يوجد اتصال بالإنترنت. سنعيد المحاولة تلقائياً.',
  });

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsetsDirectional.symmetric(
          horizontal: AlySpacing.lg,
          vertical: AlySpacing.md,
        ),
        color: c.warningMuted,
        child: Row(
          children: [
            Icon(Icons.cloud_off_rounded, size: 18, color: c.warning),
            const SizedBox(width: AlySpacing.sm),
            Expanded(
              child: Text(
                message,
                style: AlyTypography.bodySmall.copyWith(color: c.textPrimary),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
