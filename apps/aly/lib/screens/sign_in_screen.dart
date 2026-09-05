import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Rider phone OTP sign-in.
///
/// Structurally the same as the driver's, with one difference that matters: a
/// rider account is CREATED on first sign-in, whereas a driver's must already
/// exist (CLAUDE.md §2). So this screen collects a display name; the driver's
/// does not.
class SignInScreen extends StatefulWidget {
  const SignInScreen({required this.api, required this.onSignedIn, super.key});

  final ApiClient api;
  final VoidCallback onSignedIn;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _phoneController = TextEditingController();
  final _codeController = TextEditingController();
  final _nameController = TextEditingController();

  String? _verificationId;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    _nameController.dispose();
    super.dispose();
  }

  /// Firebase needs E.164 up front. The server normalises again (CLAUDE.md §8),
  /// but a rider typing `07700000001` — which is how everyone writes it here —
  /// would otherwise just see a rejection from Firebase.
  String? _toE164(String input) {
    final digits = input.replaceAll(RegExp('[^0-9+]'), '');
    if (digits.startsWith('+964')) return digits;
    if (digits.startsWith('964')) return '+$digits';
    if (digits.startsWith('0')) return '+964${digits.substring(1)}';
    if (digits.length == 10) return '+964$digits';
    return null;
  }

  Future<void> _sendCode() async {
    final strings = AppStrings.of(context);
    final phone = _toE164(_phoneController.text.trim());

    if (phone == null) {
      setState(() => _error = strings.invalidPhone);
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    await FirebaseAuth.instance.verifyPhoneNumber(
      phoneNumber: phone,
      verificationCompleted: _exchange,
      verificationFailed: (error) {
        if (!mounted) return;
        setState(() {
          _busy = false;
          _error = error.code == 'invalid-phone-number'
              ? strings.invalidPhone
              : strings.somethingWentWrong;
        });
      },
      codeSent: (verificationId, _) {
        if (!mounted) return;
        setState(() {
          _busy = false;
          _verificationId = verificationId;
        });
      },
      codeAutoRetrievalTimeout: (verificationId) {
        if (mounted) setState(() => _verificationId = verificationId);
      },
    );
  }

  Future<void> _verifyCode() async {
    final verificationId = _verificationId;
    if (verificationId == null) return;

    setState(() {
      _busy = true;
      _error = null;
    });

    await _exchange(
      PhoneAuthProvider.credential(
        verificationId: verificationId,
        smsCode: _codeController.text.trim(),
      ),
    );
  }

  Future<void> _exchange(PhoneAuthCredential credential) async {
    final strings = AppStrings.of(context);

    try {
      final result = await FirebaseAuth.instance.signInWithCredential(credential);
      final idToken = await result.user?.getIdToken();

      if (idToken == null) {
        setState(() {
          _busy = false;
          _error = strings.somethingWentWrong;
        });
        return;
      }

      await _signInWithEitherRole(idToken);

      if (mounted) widget.onSignedIn();
    } on FirebaseAuthException catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = error.code == 'invalid-verification-code'
            ? strings.invalidCode
            : strings.somethingWentWrong;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = error.problem == ApiProblem.network
            ? strings.noInternet
            : strings.somethingWentWrong;
      });
    }
  }

  /// Exchange the Firebase token for a session, trying DRIVER before RIDER.
  ///
  /// ## Why this is not just `role: UserRole.rider`
  ///
  /// The server resolves an account by **(phone, role)**, not by phone alone -
  /// `AuthService.signIn` calls `findByPhoneAndRole`, and one number can own a
  /// rider row and a driver row that are different users. In two separate apps
  /// that was invisible: each binary hardcoded its own role.
  ///
  /// One app cannot hardcode either. Sending RIDER always would sign a real
  /// driver into a rider account - creating one on the spot if none existed -
  /// and they would never reach Driver mode, no matter what
  /// `/me/capabilities` said. Sending DRIVER always would refuse every
  /// passenger, since v1 has no driver self-signup.
  ///
  /// So: ask for DRIVER first, and fall back to RIDER when the server says no
  /// driver account exists. The order is deliberate - a number that owns both
  /// gets the driver session, and `canRide` stays true for any active account,
  /// so that person still has both modes. RIDER-first would have silently
  /// stranded them in the mode with fewer capabilities.
  ///
  /// ## Why a 403 is not treated as an error here
  ///
  /// "No driver account exists for this number" is the ordinary case for every
  /// passenger who ever installs this app. It is a routing signal, not a
  /// failure, and it is the ONLY 403 that is swallowed - a deactivated account
  /// also answers 403, and re-asking as RIDER would create a fresh rider
  /// account for someone who was just banned. That is why the retry is gated
  /// on the account-existence branch and re-throws anything else.
  ///
  /// The proper fix is one identity per phone with capabilities deciding the
  /// mode, which is what CLAUDE.md §1.1 describes. That is a schema and
  /// migration change against live accounts, so it is not made here: see
  /// DECISIONS.md D-023.
  Future<void> _signInWithEitherRole(String idToken) async {
    final displayName = _nameController.text.trim().isEmpty
        ? null
        : _nameController.text.trim();

    try {
      await widget.api.verifyOtp(
        firebaseIdToken: idToken,
        role: UserRole.driver,
      );
      return;
    } on ApiException catch (error) {
      if (!_isNoDriverAccount(error)) rethrow;
    }

    await widget.api.verifyOtp(
      firebaseIdToken: idToken,
      role: UserRole.rider,
      displayName: displayName,
    );
  }

  /// True only for "this number has no driver account".
  ///
  /// Matched on the problem type plus the server's own wording, because the
  /// API returns a plain `forbidden` for BOTH "no driver account" and "this
  /// account has been deactivated" and the two must not be confused. A
  /// dedicated problem type would be better and is a contract change; until
  /// then this errs toward NOT retrying - an unrecognised 403 propagates.
  bool _isNoDriverAccount(ApiException error) {
    if (error.problem != ApiProblem.forbidden) return false;
    final detail = error.detail ?? '';
    return detail.contains('No driver account exists');
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final awaitingCode = _verificationId != null;

    return Scaffold(
      appBar: AppBar(title: Text(strings.signInTitle)),
      // Scrollable, not a bare Column.
      //
      // A Column directly under Scaffold.body inherits the viewport height as a
      // hard constraint, so any content taller than the screen is a RenderFlex
      // overflow rather than something the user can reach. A real device found
      // it immediately: `BOTTOM OVERFLOWED BY 34 PIXELS` on a Samsung SC-53C in
      // landscape.
      //
      // Landscape is not the only way it happens. The same overflow appears
      // when the keyboard opens over a short screen, and when the system font
      // scale is turned up - which the people most likely to need it will have
      // done. On the rider this screen is the taller of the two, because it
      // also collects a display name.
      //
      // Scrolling rather than shrinking: nothing here is optional, and a login
      // form that hides its own submit button is worse than one that scrolls.
      // Portrait is unchanged - with no Spacer and no mainAxisAlignment, the
      // children were already top-aligned, and a shrink-wrapped Column puts
      // them in exactly the same place.
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsetsDirectional.all(AlySpacing.xl),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_error != null) ...[
                StatusBanner(message: _error!, tone: BannerTone.danger),
                const SizedBox(height: AlySpacing.lg),
              ],

              if (!awaitingCode) ...[
                // The design system's field, which carries the `+964` prefix
                // itself. `_toE164` still normalises what comes back, because
                // a rider who types the leading `0` out of habit is typing the
                // number the way it is written everywhere in Baghdad.
                AlyPhoneField(
                  controller: _phoneController,
                  label: strings.phoneNumber,
                  enabled: !_busy,
                ),
                const SizedBox(height: AlySpacing.lg),
                AlyTextField(
                  label: strings.yourName,
                  controller: _nameController,
                  enabled: !_busy,
                ),
                const SizedBox(height: AlySpacing.xl),
                AlyButton(
                  label: strings.sendCode,
                  onPressed: _sendCode,
                  isLoading: _busy,
                ),
              ] else ...[
                Text(
                  '${strings.codeSentTo} ${_phoneController.text}',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: AlySpacing.lg),
                // The six-box input from the design system, not one centred
                // field. It holds its own text; `_codeController` stays the
                // single source `_verifyCode` reads, so the two cannot drift.
                AlyOtpInput(
                  enabled: !_busy,
                  onChanged: (code) => _codeController.text = code,
                  // Submitting on the sixth digit is the whole point of the
                  // six-box shape: there is nothing left to decide.
                  onCompleted: (code) {
                    _codeController.text = code;
                    if (!_busy) unawaited(_verifyCode());
                  },
                ),
                const SizedBox(height: AlySpacing.xl),
                AlyButton(
                  label: strings.verify,
                  onPressed: _verifyCode,
                  isLoading: _busy,
                ),
                const SizedBox(height: AlySpacing.sm),
                AlyButton(
                  label: strings.resendCode,
                  onPressed:
                      _busy ? null : () => setState(() => _verificationId = null),
                  variant: AlyButtonVariant.tertiary,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
