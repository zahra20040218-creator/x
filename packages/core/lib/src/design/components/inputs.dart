import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:rideapp_core/src/design/tokens/colors.dart';
import 'package:rideapp_core/src/design/tokens/metrics.dart';
import 'package:rideapp_core/src/design/tokens/typography.dart';

/// Text entry.
///
/// ## The rule that shapes all of these
///
/// **Minimal typing.** This app is used one-handed, in a car, often moving. Every
/// field below either avoids typing (the search field's "use my location") or
/// makes the typing that remains as short as possible (national digits, not
/// E.164; six boxes, not a free-text code).

/// The standard field.
///
/// Reserves the height of its error line whether or not there is an error, so
/// the form does not jump when validation fires. A field that grows on error
/// pushes the submit button under the user's thumb at the exact moment they are
/// reaching for it.
class AlyTextField extends StatelessWidget {
  const AlyTextField({
    required this.label,
    super.key,
    this.controller,
    this.hint,
    this.errorText,
    this.enabled = true,
    this.keyboardType,
    this.textInputAction,
    this.maxLength,
    this.prefixIcon,
    this.onChanged,
    this.onSubmitted,
    this.autofocus = false,
    this.obscureText = false,
    this.inputFormatters,
    this.textDirection,
  });

  final String label;
  final TextEditingController? controller;
  final String? hint;
  final String? errorText;
  final bool enabled;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final int? maxLength;
  final IconData? prefixIcon;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;
  final bool obscureText;
  final List<TextInputFormatter>? inputFormatters;

  /// Forced direction for the VALUE. A phone number or an amount reads
  /// left-to-right even on an Arabic page; prose does not.
  final TextDirection? textDirection;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          label,
          style: AlyTypography.label.copyWith(
            color: enabled ? c.textSecondary : c.textDisabled,
          ),
        ),
        const SizedBox(height: AlySpacing.sm),
        TextField(
          controller: controller,
          enabled: enabled,
          autofocus: autofocus,
          obscureText: obscureText,
          keyboardType: keyboardType,
          textInputAction: textInputAction,
          maxLength: maxLength,
          inputFormatters: inputFormatters,
          textDirection: textDirection,
          onChanged: onChanged,
          onSubmitted: onSubmitted,
          style: AlyTypography.body.copyWith(
            color: enabled ? c.textPrimary : c.textDisabled,
          ),
          decoration: InputDecoration(
            hintText: hint,
            prefixIcon: prefixIcon == null ? null : Icon(prefixIcon, size: 20),
            // The counter is suppressed even when maxLength is set: it is
            // decoration that pushes the layout around, and the formatter
            // already makes over-typing impossible.
            counterText: '',
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AlyRadius.sm),
              borderSide: errorText == null
                  ? BorderSide.none
                  : BorderSide(color: c.error, width: 1.5),
            ),
          ),
        ),
        // Always laid out. Empty when valid.
        SizedBox(
          height: AlySpacing.xl,
          child: errorText == null
              ? null
              : Padding(
                  padding: const EdgeInsetsDirectional.only(
                    top: AlySpacing.xs,
                    start: AlySpacing.xs,
                  ),
                  child: Text(
                    errorText!,
                    style: AlyTypography.bodySmall.copyWith(color: c.error),
                  ),
                ),
        ),
      ],
    );
  }
}

/// Iraqi phone entry.
///
/// ## Two decisions that are easy to get wrong
///
/// **The user types national digits.** `07XXXXXXXXX`, the way an Iraqi writes
/// their own number. The `+964` is shown as a fixed affix and is not editable,
/// and normalisation to E.164 happens on the server (CLAUDE.md §8). Asking
/// someone to type `+9647...` is asking them to translate their own phone
/// number into a format they never use.
///
/// **The digits are LTR inside an RTL page.** Without the inner
/// [Directionality], `+964` lands at the wrong end of the field and the whole
/// thing reads as a typo. This is the single most common Arabic-app bug in a
/// phone field and it is invisible to anyone testing in English.
class AlyPhoneField extends StatelessWidget {
  const AlyPhoneField({
    required this.controller,
    super.key,
    this.label = 'رقم الهاتف',
    this.errorText,
    this.enabled = true,
    this.autofocus = false,
    this.onChanged,
    this.onSubmitted,
  });

  final TextEditingController controller;
  final String label;
  final String? errorText;
  final bool enabled;
  final bool autofocus;

  /// Receives the raw national digits, exactly as typed.
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          label,
          style: AlyTypography.label.copyWith(
            color: enabled ? c.textSecondary : c.textDisabled,
          ),
        ),
        const SizedBox(height: AlySpacing.sm),
        Directionality(
          // The value, not the page.
          textDirection: TextDirection.ltr,
          child: Row(
            children: [
              Container(
                height: AlySpacing.tapTarget,
                padding: const EdgeInsets.symmetric(horizontal: AlySpacing.md),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: c.surfaceSunken,
                  borderRadius: const BorderRadius.horizontal(
                    left: Radius.circular(AlyRadius.sm),
                  ),
                  border: Border(right: BorderSide(color: c.border)),
                ),
                child: Text(
                  '+964',
                  style: AlyTypography.numericSmall.copyWith(color: c.textSecondary),
                ),
              ),
              Expanded(
                child: TextField(
                  controller: controller,
                  enabled: enabled,
                  autofocus: autofocus,
                  keyboardType: TextInputType.phone,
                  textInputAction: TextInputAction.done,
                  onChanged: onChanged,
                  onSubmitted: onSubmitted,
                  inputFormatters: [
                    FilteringTextInputFormatter.digitsOnly,
                    // 11 for the leading zero form the user actually types.
                    LengthLimitingTextInputFormatter(11),
                  ],
                  style: AlyTypography.numericSmall.copyWith(
                    color: enabled ? c.textPrimary : c.textDisabled,
                  ),
                  decoration: InputDecoration(
                    hintText: '07XXXXXXXX',
                    hintStyle: AlyTypography.numericSmall.copyWith(color: c.textTertiary),
                    counterText: '',
                    border: const OutlineInputBorder(
                      borderRadius: BorderRadius.horizontal(
                        right: Radius.circular(AlyRadius.sm),
                      ),
                      borderSide: BorderSide.none,
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: const BorderRadius.horizontal(
                        right: Radius.circular(AlyRadius.sm),
                      ),
                      borderSide: errorText == null
                          ? BorderSide.none
                          : BorderSide(color: c.error, width: 1.5),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        SizedBox(
          height: AlySpacing.xl,
          child: errorText == null
              ? null
              : Padding(
                  padding: const EdgeInsetsDirectional.only(
                    top: AlySpacing.xs,
                    start: AlySpacing.xs,
                  ),
                  child: Text(
                    errorText!,
                    style: AlyTypography.bodySmall.copyWith(color: c.error),
                  ),
                ),
        ),
      ],
    );
  }
}

/// Destination search.
///
/// The clear button appears only when there is something to clear — a control
/// that is permanently visible and usually inert is noise, and on a search
/// field it sits exactly where the thumb rests.
class AlySearchField extends StatefulWidget {
  const AlySearchField({
    required this.controller,
    super.key,
    this.hint = 'إلى أين تريد الذهاب؟',
    this.autofocus = false,
    this.onChanged,
    this.onSubmitted,
    this.onUseCurrentLocation,
    this.enabled = true,
  });

  final TextEditingController controller;
  final String hint;
  final bool autofocus;
  final bool enabled;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;

  /// Offered as a trailing action when present. The fastest possible answer to
  /// "where are you" is not typing.
  final VoidCallback? onUseCurrentLocation;

  @override
  State<AlySearchField> createState() => _AlySearchFieldState();
}

class _AlySearchFieldState extends State<AlySearchField> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onTextChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTextChanged);
    super.dispose();
  }

  void _onTextChanged() {
    // Only the presence of text matters here, so a rebuild per keystroke is
    // avoided once the button is already in the right state.
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final hasText = widget.controller.text.isNotEmpty;

    return Container(
      height: AlySpacing.tapTarget,
      padding: const EdgeInsetsDirectional.symmetric(horizontal: AlySpacing.md),
      decoration: BoxDecoration(
        color: c.surfaceSunken,
        borderRadius: BorderRadius.circular(AlyRadius.sm),
      ),
      child: Row(
        children: [
          Icon(Icons.search_rounded, size: 20, color: c.textTertiary),
          const SizedBox(width: AlySpacing.sm),
          Expanded(
            child: TextField(
              controller: widget.controller,
              enabled: widget.enabled,
              autofocus: widget.autofocus,
              textInputAction: TextInputAction.search,
              onChanged: widget.onChanged,
              onSubmitted: widget.onSubmitted,
              style: AlyTypography.body.copyWith(color: c.textPrimary),
              decoration: InputDecoration(
                isDense: true,
                hintText: widget.hint,
                hintStyle: AlyTypography.body.copyWith(color: c.textTertiary),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: EdgeInsets.zero,
                filled: false,
              ),
            ),
          ),
          if (hasText)
            Semantics(
              button: true,
              label: 'مسح',
              child: InkWell(
                onTap: () {
                  widget.controller.clear();
                  widget.onChanged?.call('');
                },
                borderRadius: BorderRadius.circular(AlyRadius.pill),
                child: Padding(
                  padding: const EdgeInsets.all(AlySpacing.xs),
                  child: Icon(Icons.close_rounded, size: 18, color: c.textSecondary),
                ),
              ),
            )
          else if (widget.onUseCurrentLocation != null)
            Semantics(
              button: true,
              label: 'استخدام موقعي الحالي',
              child: InkWell(
                onTap: widget.onUseCurrentLocation,
                borderRadius: BorderRadius.circular(AlyRadius.pill),
                child: Padding(
                  padding: const EdgeInsets.all(AlySpacing.xs),
                  child: Icon(Icons.my_location_rounded, size: 18, color: c.primary),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// The OTP code.
///
/// ## One field, drawn as several boxes
///
/// A screen reader is told this is a single code entry, not six separate
/// inputs — six labelled boxes is a genuinely hostile experience for anyone
/// using one. The boxes are presentation; a single hidden [TextField] holds the
/// value, receives the paste, and drives the keyboard.
///
/// That structure also gets three things right for free that a
/// six-controller implementation gets wrong: pasting a full code fills every
/// box, autofill from an SMS works, and backspace behaves the way the platform
/// keyboard expects rather than the way a hand-rolled focus chain guesses.
class AlyOtpInput extends StatefulWidget {
  const AlyOtpInput({
    super.key,
    this.length = 6,
    this.onCompleted,
    this.onChanged,
    this.enabled = true,
    this.autofocus = true,
    this.errorText,
  });

  final int length;
  final ValueChanged<String>? onCompleted;
  final ValueChanged<String>? onChanged;
  final bool enabled;
  final bool autofocus;
  final String? errorText;

  @override
  State<AlyOtpInput> createState() => _AlyOtpInputState();
}

class _AlyOtpInputState extends State<AlyOtpInput> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onChanged);
    _focusNode.addListener(() {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _controller
      ..removeListener(_onChanged)
      ..dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _onChanged() {
    if (!mounted) return;
    setState(() {});
    final value = _controller.text;
    widget.onChanged?.call(value);
    if (value.length == widget.length) widget.onCompleted?.call(value);
  }

  @override
  Widget build(BuildContext context) {
    final c = AlyColors.of(context);
    final value = _controller.text;

    return Semantics(
      // Announced as ONE field. `excludeSemantics` hides the decorative boxes
      // so a screen reader does not read out six unlabelled containers.
      textField: true,
      label: 'رمز التحقق، ${widget.length} أرقام',
      value: value.isEmpty ? 'فارغ' : '${value.length} من ${widget.length}',
      excludeSemantics: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Stack(
            children: [
              // The real input, invisible but focusable and pastable.
              Opacity(
                opacity: 0,
                child: SizedBox(
                  height: AlySpacing.tapTarget,
                  child: TextField(
                    controller: _controller,
                    focusNode: _focusNode,
                    enabled: widget.enabled,
                    autofocus: widget.autofocus,
                    keyboardType: TextInputType.number,
                    // Lets the platform fill it from the SMS, which removes the
                    // typing entirely on Android.
                    autofillHints: const [AutofillHints.oneTimeCode],
                    inputFormatters: [
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(widget.length),
                    ],
                    showCursor: false,
                  ),
                ),
              ),
              // The boxes.
              GestureDetector(
                onTap: widget.enabled ? _focusNode.requestFocus : null,
                behavior: HitTestBehavior.opaque,
                child: Directionality(
                  // Digits fill from the left in every language.
                  textDirection: TextDirection.ltr,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: List.generate(widget.length, (index) {
                      final filled = index < value.length;
                      final isNext = index == value.length && _focusNode.hasFocus;

                      return Padding(
                        padding: const EdgeInsets.symmetric(horizontal: AlySpacing.xs),
                        child: AnimatedContainer(
                          duration: AlyMotion.respecting(context, AlyMotion.fast),
                          width: 44,
                          height: AlySpacing.tapTarget,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: c.surfaceSunken,
                            borderRadius: BorderRadius.circular(AlyRadius.sm),
                            border: Border.all(
                              color: widget.errorText != null
                                  ? c.error
                                  : isNext
                                      ? c.borderFocus
                                      : Colors.transparent,
                              width: isNext || widget.errorText != null ? 2 : 1,
                            ),
                          ),
                          child: Text(
                            filled ? value[index] : '',
                            style: AlyTypography.numeric.copyWith(color: c.textPrimary),
                          ),
                        ),
                      );
                    }),
                  ),
                ),
              ),
            ],
          ),
          SizedBox(
            height: AlySpacing.xl,
            child: widget.errorText == null
                ? null
                : Padding(
                    padding: const EdgeInsetsDirectional.only(top: AlySpacing.xs),
                    child: Text(
                      widget.errorText!,
                      textAlign: TextAlign.center,
                      style: AlyTypography.bodySmall.copyWith(color: c.error),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
