import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// Phone OTP sign-in (CLAUDE.md §2, Firebase Phone Auth).
///
/// The server never sees or generates an OTP code — Firebase does that on the
/// device and hands back a signed ID token, which is what we exchange for
/// platform tokens. That is why there is no "verify code" call to our own API
/// anywhere in this file.
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

  String? _verificationId;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  /// Normalise before sending to Firebase.
  ///
  /// The server normalises too (CLAUDE.md §8), but Firebase needs E.164 up
  /// front or it rejects the request — and a driver typing `07700000001`, which
  /// is how every Iraqi writes their number, would otherwise just see a failure.
  String? _toE164(String input) {
    final digits = input.replaceAll(RegExp(r'[^0-9+]'), '');
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
      verificationCompleted: (credential) async {
        // Android auto-retrieval: the code arrived and was read for us.
        await _exchange(credential);
      },
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

  /// Firebase credential -> platform session.
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

      await widget.api.verifyOtp(
        firebaseIdToken: idToken,
        role: UserRole.driver,
      );

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
        // CLAUDE.md §2 - a driver account must already exist. This is the
        // message that tells them why, rather than a generic failure.
        _error = switch (error.problem) {
          ApiProblem.forbidden => strings.driverAccountNotFound,
          ApiProblem.network => strings.noInternet,
          _ => strings.somethingWentWrong,
        };
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final awaitingCode = _verificationId != null;

    return Scaffold(
      appBar: AppBar(title: Text(strings.signInTitle)),
      body: Padding(
        padding: const EdgeInsetsDirectional.all(AppSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_error != null) ...[
              StatusBanner(message: _error!, tone: BannerTone.danger),
              const SizedBox(height: AppSpacing.md),
            ],

            if (!awaitingCode) ...[
              Text(strings.phoneNumber,
                  style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: AppSpacing.sm),
              TextField(
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                textDirection: TextDirection.ltr,
                decoration: InputDecoration(hintText: strings.phoneHint),
              ),
              const SizedBox(height: AppSpacing.lg),
              PrimaryButton(
                label: strings.sendCode,
                onPressed: _sendCode,
                busy: _busy,
              ),
            ] else ...[
              Text(
                '${strings.codeSentTo} ${_phoneController.text}',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.md),
              TextField(
                controller: _codeController,
                keyboardType: TextInputType.number,
                textDirection: TextDirection.ltr,
                textAlign: TextAlign.center,
                decoration: InputDecoration(hintText: strings.enterCode),
              ),
              const SizedBox(height: AppSpacing.lg),
              PrimaryButton(
                label: strings.verify,
                onPressed: _verifyCode,
                busy: _busy,
              ),
              TextButton(
                onPressed: _busy ? null : () => setState(() => _verificationId = null),
                child: Text(strings.resendCode),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
