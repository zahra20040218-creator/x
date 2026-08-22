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
  /// but a rider typing `07701234567` — which is how everyone writes it here —
  /// would otherwise just see a rejection from Firebase.
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

      await widget.api.verifyOtp(
        firebaseIdToken: idToken,
        role: UserRole.rider,
        displayName: _nameController.text.trim().isEmpty
            ? null
            : _nameController.text.trim(),
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
        _error = error.problem == ApiProblem.network
            ? strings.noInternet
            : strings.somethingWentWrong;
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
              const SizedBox(height: AppSpacing.md),
              Text(strings.yourName,
                  style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: AppSpacing.sm),
              TextField(controller: _nameController),
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
                onPressed:
                    _busy ? null : () => setState(() => _verificationId = null),
                child: Text(strings.resendCode),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
