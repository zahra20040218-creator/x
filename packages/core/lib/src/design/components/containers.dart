import 'package:flutter/material.dart';
import 'package:rideapp_core/src/design/components/buttons.dart';
import 'package:rideapp_core/src/design/tokens/colors.dart';
import 'package:rideapp_core/src/design/tokens/metrics.dart';
import 'package:rideapp_core/src/design/tokens/typography.dart';

/// Surfaces and overlays: the shapes content sits on, and the shapes that sit
/// on top of everything else.
///
/// One file because they are one decision — how this product expresses *depth*.
/// A card, a sheet and a dialog are three heights of the same idea, and if they
/// are written in three places they drift into three unrelated visual
/// languages, which is exactly how an app starts to look assembled from parts.

/// The label used for "no" everywhere in the product.
///
/// Defaulted rather than required so that five screens do not invent five
/// different Arabic words for the same action. A caller with a genuinely
/// different meaning ("ليس الآن", "الاحتفاظ بالرحلة") still passes their own.
const String _defaultCancelLabel = 'إلغاء';

/// The standard container: a plane that holds related content.
///
/// ## Why the shadow disappears in dark mode
///
/// In light mode a card is white on a grey background and elevation is carried
/// by a shadow — there is nothing lighter than white to raise it with. In dark
/// mode the opposite is true: shadows are nearly invisible on `grey950`, so
/// elevation is carried by *luminance* and the card is drawn on
/// `surfaceElevated`, one step lighter than `surface`. Keeping the shadow in
/// dark mode would cost a full layer of compositing to render a smudge nobody
/// can see. This is stated at length in `AlyColors`' own doc comment; it is
/// repeated here because this is the widget where getting it wrong is
/// invisible to anyone testing in a bright room.
///
/// ## The press state
///
/// A tappable card tints to `primaryMuted` rather than scaling like
/// [AlyButton]. A button is small enough that a 2% scale reads as a press; a
/// full-width card scaling reads as the whole screen flinching. The tint is the
/// same token a selected row uses, which is what a pressed row is on its way to
/// becoming.
class AlyCard extends StatefulWidget {
  const AlyCard({
    required this.child,
    super.key,
    this.onTap,
    this.padding = const EdgeInsetsDirectional.all(AlySpacing.lg),
    this.semanticLabel,
  });

  final Widget child;

  /// Null leaves the card inert: no press state, no button semantics, and no
  /// gesture arena entry to steal a drag from a list underneath it.
  final VoidCallback? onTap;

  /// Overridable for the one case the default cannot serve: content that must
  /// reach the card's edge, such as a map thumbnail or a full-bleed list. Any
  /// value passed here must still be built from [AlySpacing] constants.
  final EdgeInsetsDirectional padding;

  /// What a screen reader announces for a tappable card. A card usually reads
  /// itself out through its children, so this is only needed when the card
  /// means more than the sum of them — "رحلة إلى الكرادة، 12,500 دينار".
  final String? semanticLabel;

  @override
  State<AlyCard> createState() => _AlyCardState();
}

class _AlyCardState extends State<AlyCard> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final isDark = c.brightness == Brightness.dark;
    final tappable = widget.onTap != null;

    final surface = isDark ? c.surfaceElevated : c.surface;

    final card = AnimatedContainer(
      duration: AlyMotion.respecting(context, AlyMotion.fast),
      curve: AlyMotion.standard,
      // A tappable card is a control, so it obeys the same floor every other
      // control does — a card three lines tall is easy to hit, a card holding
      // one short line is not.
      constraints: BoxConstraints(
        minHeight: tappable ? AlySpacing.tapTargetSmall : 0,
      ),
      padding: widget.padding,
      decoration: BoxDecoration(
        color: _pressed ? c.primaryMuted : surface,
        borderRadius: BorderRadius.circular(AlyRadius.md),
        // The hairline stays in both modes. It is what separates two stacked
        // cards when the shadow is gone.
        border: Border.all(color: c.border),
        boxShadow: isDark ? AlyElevation.none : AlyElevation.low,
      ),
      child: widget.child,
    );

    if (!tappable) return card;

    return Semantics(
      button: true,
      label: widget.semanticLabel,
      child: GestureDetector(
        // Opaque, so the padding around the content is part of the target
        // rather than a dead border the user has to aim past.
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => setState(() => _pressed = true),
        onTapUp: (_) => setState(() => _pressed = false),
        onTapCancel: () => setState(() => _pressed = false),
        onTap: widget.onTap,
        child: card,
      ),
    );
  }
}

/// The content scaffold for a bottom sheet: a title, a scrolling body, and an
/// action area pinned to the bottom.
///
/// ## Why the footer is pinned rather than scrolled
///
/// This is the shape of the offer sheet and the fare sheet — the two moments in
/// the product where a decision is made against a clock. If the primary action
/// is the last child of a scroll view, then a sheet whose body is one line too
/// tall hides "قبول" below the fold, and the driver spends part of a
/// fifteen-second window discovering that the sheet scrolls. The body scrolls;
/// the decision never moves.
///
/// ## The keyboard
///
/// The whole sheet is inset by `viewInsets.bottom`, so when a keyboard opens
/// the footer rides up with it and the *body* is what loses height. The naive
/// alternative — letting the route resize and the footer scroll away — puts the
/// confirm button behind the keyboard on precisely the screens that have a text
/// field, which is where a confirm button matters most.
class AlySheet extends StatelessWidget {
  const AlySheet({
    required this.title,
    required this.child,
    super.key,
    this.subtitle,
    this.onClose,
    this.closeSemanticLabel = 'إغلاق',
    this.actions = const <Widget>[],
  });

  /// Presents [builder]'s sheet modally.
  ///
  /// [builder] returns the sheet rather than the caller passing a finished
  /// widget, because the actions need the *sheet's* context to pop the route
  /// with a result. Handing them the calling screen's context works right up
  /// until the sheet is opened from somewhere that is not the top route, at
  /// which point it pops the wrong thing.
  ///
  /// `isScrollControlled` is always on: without it Flutter caps a modal sheet
  /// at half the screen and a body that needs more simply overflows.
  static Future<T?> show<T>(
    BuildContext context, {
    required WidgetBuilder builder,
    bool isDismissible = true,
  }) {
    final c = AlyColors.of(context);

    return showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      isDismissible: isDismissible,
      // A sheet that cannot be dismissed by tapping away must not be
      // dismissable by a flick either, or the two behaviours disagree and the
      // user finds the one that loses their input.
      enableDrag: isDismissible,
      useSafeArea: true,
      barrierColor: c.scrim,
      // Never full height. On the ride screens the map behind the sheet is
      // context, not decoration — a sheet that covers it leaves the rider
      // unable to see where the car is while reading about it.
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.9,
      ),
      builder: builder,
    );
  }

  final String title;

  /// The scrolling body.
  final Widget child;

  /// One supporting line under the title. Anything longer belongs in the body.
  final String? subtitle;

  /// Omitted deliberately on a sheet the user must answer rather than dismiss —
  /// a ride offer has "قبول" and "رفض", and no third silent way out that leaves
  /// the server waiting on a timeout.
  final VoidCallback? onClose;

  final String closeSemanticLabel;

  /// Pinned to the bottom, stacked, full width. Stacked rather than side by
  /// side because two Arabic labels in a row are the first thing to overflow at
  /// a large font scale, and the primary action is the last thing that should
  /// be allowed to ellipsis.
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _header(c),
          // Flexible, not Expanded: a short sheet hugs its content instead of
          // stretching to the cap set in [show].
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsetsDirectional.fromSTEB(
                AlySpacing.lg,
                0,
                AlySpacing.lg,
                AlySpacing.lg,
              ),
              child: child,
            ),
          ),
          if (actions.isNotEmpty) _footer(c),
        ],
      ),
    );
  }

  Widget _header(AlyColors c) => Padding(
        padding: EdgeInsetsDirectional.fromSTEB(
          AlySpacing.lg,
          AlySpacing.sm,
          // The close button carries its own 48pt target, which already
          // supplies most of the end gutter; a full gutter on top of it pushes
          // the icon visibly off the sheet's optical edge.
          onClose == null ? AlySpacing.lg : AlySpacing.sm,
          AlySpacing.md,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      title,
                      style: AlyTypography.h3.copyWith(color: c.textPrimary),
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: AlySpacing.xs),
                    Text(
                      subtitle!,
                      style: AlyTypography.bodySmall.copyWith(
                        color: c.textSecondary,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (onClose != null)
              AlyIconButton(
                icon: Icons.close_rounded,
                onPressed: onClose,
                semanticLabel: closeSemanticLabel,
              ),
          ],
        ),
      );

  Widget _footer(AlyColors c) => DecoratedBox(
        decoration: BoxDecoration(
          color: c.surfaceElevated,
          // The separator is what tells the eye the body has more to scroll:
          // without it, content that ends behind the footer looks like content
          // that has ended.
          border: Border(top: BorderSide(color: c.border)),
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsetsDirectional.all(AlySpacing.lg),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final (index, action) in actions.indexed) ...[
                  if (index > 0) const SizedBox(height: AlySpacing.sm),
                  action,
                ],
              ],
            ),
          ),
        ),
      );
}

/// A question with two answers, one of which may be destructive.
///
/// ## Why the destructive action is never autofocused, and never on top
///
/// A dialog appears under a thumb that is already moving. If the destructive
/// action is where the user's muscle memory expects "continue", the dialog has
/// not asked a question — it has added a step to the thing it was supposed to
/// prevent. So a destructive confirm is placed *below* the cancel, and focus
/// starts on cancel. A user who cancels a ride still cancels it in two taps;
/// they just cannot do it without looking.
///
/// Designed to be presented by [ask]. It pops its own route with the answer,
/// which is why it takes no callbacks: a confirmation dialog that reports
/// through callbacks invites a caller to forget to close it.
class AlyConfirmationDialog extends StatelessWidget {
  const AlyConfirmationDialog({
    required this.title,
    required this.message,
    required this.confirmLabel,
    super.key,
    this.cancelLabel = _defaultCancelLabel,
    this.isDestructive = false,
  });

  /// Asks, and resolves to whether the user said yes.
  ///
  /// Returns `false` for the barrier tap and for the Android back button as
  /// well as for an explicit cancel — every way of leaving without answering is
  /// the same answer, and a `null` here would only be turned into `false` by
  /// each caller anyway, one of which would eventually get it wrong on the
  /// dialog that cancels a ride.
  static Future<bool> ask(
    BuildContext context, {
    required String title,
    required String message,
    required String confirmLabel,
    String cancelLabel = _defaultCancelLabel,
    bool isDestructive = false,
  }) async {
    final confirmed = await showDialog<bool>(
      context: context,
      barrierColor: AlyColors.of(context).scrim,
      builder: (context) => AlyConfirmationDialog(
        title: title,
        message: message,
        confirmLabel: confirmLabel,
        cancelLabel: cancelLabel,
        isDestructive: isDestructive,
      ),
    );

    return confirmed ?? false;
  }

  final String title;
  final String message;
  final String confirmLabel;
  final String cancelLabel;

  /// Turns the confirm red, moves it below the cancel, and takes focus off it.
  final bool isDestructive;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    final confirm = Focus(
      autofocus: !isDestructive,
      child: isDestructive
          ? AlyButton.danger(
              label: confirmLabel,
              onPressed: () => Navigator.of(context).pop(true),
            )
          : AlyButton(
              label: confirmLabel,
              onPressed: () => Navigator.of(context).pop(true),
            ),
    );

    final cancel = Focus(
      autofocus: isDestructive,
      // Outlined next to a destructive action so the safe way out is a shape
      // the eye finds, not a line of text it has to look for.
      child: isDestructive
          ? AlyButton.secondary(
              label: cancelLabel,
              onPressed: () => Navigator.of(context).pop(false),
            )
          : AlyButton(
              label: cancelLabel,
              variant: AlyButtonVariant.tertiary,
              onPressed: () => Navigator.of(context).pop(false),
            ),
    );

    return Dialog(
      child: Padding(
        padding: const EdgeInsetsDirectional.all(AlySpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // The question scrolls, the answers do not. At a 200% font scale on
            // a short phone this is the difference between a cramped dialog and
            // a dialog whose buttons are off the bottom of the screen.
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Semantics(
                      header: true,
                      child: Text(
                        title,
                        style: AlyTypography.h3.copyWith(color: c.textPrimary),
                      ),
                    ),
                    const SizedBox(height: AlySpacing.sm),
                    Text(
                      message,
                      style: AlyTypography.body.copyWith(
                        color: c.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: AlySpacing.xl),
            if (isDestructive) ...[
              cancel,
              const SizedBox(height: AlySpacing.sm),
              confirm,
            ] else ...[
              confirm,
              const SizedBox(height: AlySpacing.sm),
              cancel,
            ],
          ],
        ),
      ),
    );
  }
}

/// Whether a person is reachable right now. Used for the driver's own state and
/// for the counterparty's.
enum AlyPresence { online, offline }

/// A person, as a circle.
///
/// ## Why it takes an `ImageProvider` and not a URL
///
/// This package does not decide how the app fetches an image. An app that later
/// wants disk caching swaps the provider and this widget does not change — and
/// a test can hand it bytes instead of standing up a fake HTTP layer. A widget
/// that takes a URL string has quietly taken a dependency on the network on
/// behalf of every screen that uses it.
///
/// ## Why one initial and not two
///
/// Arabic letters join contextually. Two initials placed side by side do not
/// read as two initials — they shape into a two-letter word, sometimes one the
/// person did not intend to be called. The Latin convention of "MA" does not
/// survive translation, so the fallback is a single glyph in both languages.
class AlyAvatar extends StatelessWidget {
  const AlyAvatar({
    required this.name,
    super.key,
    this.image,
    this.size = 44,
    this.presence,
  });

  /// Used for the fallback glyph only. Never rendered in full — the name itself
  /// belongs next to the avatar, where it can wrap.
  final String name;

  final ImageProvider<Object>? image;

  final double size;

  /// Null hides the dot entirely. An absent dot means "we are not saying",
  /// which is different from [AlyPresence.offline] and must not look the same.
  final AlyPresence? presence;

  /// The first glyph of the name, or empty if there is nothing to take.
  static String initialOf(String name) {
    final trimmed = name.trim();
    return trimmed.isEmpty ? '' : trimmed.characters.first;
  }

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final initial = initialOf(name);

    // The ring around the status dot matches the surface a card draws itself
    // on, because that is where avatars actually live. Without it the dot
    // bleeds into the avatar behind it and reads as a smudge.
    final ring = c.brightness == Brightness.dark ? c.surfaceElevated : c.surface;

    Widget visual = DecoratedBox(
      decoration: BoxDecoration(color: c.primaryMuted, shape: BoxShape.circle),
      child: Center(
        child: initial.isEmpty
            ? Icon(
                Icons.person_rounded,
                size: size * 0.5,
                color: c.textSecondary,
              )
            // The glyph does not scale with the system font setting: the circle
            // is a fixed ornament, and a letter that grows past it is a defect,
            // not an accommodation. The name beside it scales normally, and
            // that is the part a low-vision user is actually reading.
            : MediaQuery.withNoTextScaling(
                child: Text(
                  initial,
                  style: _initialStyle().copyWith(color: c.primary),
                ),
              ),
      ),
    );

    if (image != null) {
      // Stacked over the initial rather than replacing it, so a slow or broken
      // image degrades to the fallback instead of to a grey hole.
      visual = Stack(
        fit: StackFit.expand,
        children: [
          visual,
          ClipOval(
            child: Image(
              image: image!,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => const SizedBox.shrink(),
            ),
          ),
        ],
      );
    }

    final dot = size * 0.28;

    final content = SizedBox(
      width: size,
      height: size,
      child: Stack(
        children: [
          visual,
          if (presence != null)
            // Directional, so it sits bottom-left in Arabic and bottom-right in
            // English without a second layout.
            PositionedDirectional(
              bottom: 0,
              end: 0,
              child: Container(
                width: dot,
                height: dot,
                decoration: BoxDecoration(
                  color: presence == AlyPresence.online ? c.online : c.offline,
                  shape: BoxShape.circle,
                  border: Border.all(color: ring, width: 2),
                ),
              ),
            ),
        ],
      ),
    );

    // With no dot the avatar carries nothing a screen reader needs: the name is
    // already on the row beside it, and announcing it twice is noise. With a
    // dot it carries a fact that exists nowhere else on the screen.
    return presence == null
        ? ExcludeSemantics(child: content)
        : Semantics(
            label: presence == AlyPresence.online ? 'متصل' : 'غير متصل',
            child: ExcludeSemantics(child: content),
          );
  }

  /// Picks a style off the scale rather than deriving a font size from [size].
  /// A computed size would be the one piece of type in the product that is not
  /// on the ramp.
  TextStyle _initialStyle() {
    if (size >= 56) return AlyTypography.h2;
    if (size >= 40) return AlyTypography.title;
    return AlyTypography.label;
  }
}

/// The five things a badge can mean.
///
/// Deliberately not open-ended. A badge whose colour is passed in by the caller
/// becomes a badge with eleven colours, none of which mean anything
/// consistently across screens.
enum AlyBadgeTone { neutral, success, warning, error, info }

/// A small status pill: "مكتملة", "بانتظار سائق", "ملغاة".
///
/// Text only. An icon inside a 12pt pill is three pixels of meaning next to a
/// word that already carries it, and in Arabic it also has to be mirrored —
/// cost with no return. The muted background plus the solid foreground of the
/// same tone is what keeps it readable in both modes at 3:1 or better.
class AlyBadge extends StatelessWidget {
  const AlyBadge({
    required this.label,
    super.key,
    this.tone = AlyBadgeTone.neutral,
  });

  final String label;
  final AlyBadgeTone tone;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    final (background, foreground) = switch (tone) {
      AlyBadgeTone.neutral => (c.surfaceSunken, c.textSecondary),
      AlyBadgeTone.success => (c.successMuted, c.success),
      AlyBadgeTone.warning => (c.warningMuted, c.warning),
      AlyBadgeTone.error => (c.errorMuted, c.error),
      AlyBadgeTone.info => (c.infoMuted, c.info),
    };

    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        // The one place [AlyRadius.pill] is right on something that is not a
        // circle: a status word reads as a label, not as a small card.
        borderRadius: BorderRadius.circular(AlyRadius.pill),
      ),
      child: Padding(
        padding: const EdgeInsetsDirectional.symmetric(
          horizontal: AlySpacing.md,
          vertical: AlySpacing.xs,
        ),
        child: Text(
          label,
          style: AlyTypography.label.copyWith(color: foreground),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );
  }
}
