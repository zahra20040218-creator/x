import 'package:flutter/material.dart';
import 'package:rideapp_core/rideapp_core.dart';

/// The rider's own account.
///
/// The only screen that shows the account's phone number. `PublicUser` — the
/// shape used everywhere a counterparty is displayed — has no phone field at
/// all, which is what stops a driver's details leaking a rider's number and
/// vice versa. `Me` is a separate type for exactly that reason.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({
    required this.api,
    required this.onSignedOut,
    super.key,
  });

  final ApiClient api;

  /// Called after the server has revoked the session, so the app can route
  /// back to sign-in.
  final VoidCallback onSignedOut;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  ViewState<Me> _state = const ViewState<Me>.loading();
  final _nameController = TextEditingController();
  bool _saving = false;
  bool _signingOut = false;
  String? _saveError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _state = const ViewState<Me>.loading());
    try {
      final me = await widget.api.me();
      if (!mounted) return;
      _nameController.text = me.displayName;
      setState(() => _state = ViewState<Me>.success(me));
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _state = ViewState<Me>.error(
            error.detail ?? error.problem.slug,
            canRetry: !error.requiresReauthentication,
          ),);
    }
  }

  Future<void> _save() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) return;

    setState(() {
      _saving = true;
      _saveError = null;
    });

    try {
      final updated = await widget.api.updateMe(displayName: name);
      if (!mounted) return;
      setState(() => _state = ViewState<Me>.success(updated));

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppStrings.of(context).saved)),
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      // Shown inline rather than replacing the screen: the profile is still
      // perfectly readable, only the save failed.
      setState(() => _saveError = error.detail ?? error.problem.slug);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _signOut() async {
    setState(() => _signingOut = true);
    try {
      // Server-side first. `POST /auth/logout` revokes the session, which
      // since migration 0006 kills the access token immediately rather than
      // leaving it valid for the rest of its hour.
      await widget.api.logout();
    } on ApiException {
      // Deliberately swallowed. A network failure must not strand the user in
      // a screen they cannot leave; the local tokens are cleared either way,
      // and a stale refresh token expires on its own.
    } finally {
      if (mounted) {
        setState(() => _signingOut = false);
        widget.onSignedOut();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(strings.profile)),
      body: AsyncView<Me>(
        state: _state,
        onRetry: _load,
        // A profile always has a user. Empty is unreachable, but AsyncView
        // requires it rather than letting a screen silently omit a state.
        empty: (context) => EmptyView(message: strings.somethingWentWrong),
        success: (context, me) => ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(strings.phone, style: Theme.of(context).textTheme.bodySmall),
                    Text(
                      me.phone,
                      // A phone number reads left-to-right inside an RTL page.
                      textDirection: TextDirection.ltr,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: AppSpacing.md),

                    TextField(
                      controller: _nameController,
                      enabled: !_saving,
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => _save(),
                      decoration: InputDecoration(
                        labelText: strings.displayName,
                        errorText: _saveError,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.md),

                    PrimaryButton(
                      label: _saving ? strings.saving : strings.save,
                      onPressed: _saving ? null : _save,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.lg),

            OutlinedButton.icon(
              onPressed: _signingOut ? null : _signOut,
              icon: const Icon(Icons.logout),
              label: Text(_signingOut ? strings.loading : strings.signOut),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.danger,
                // 48dp: the Material minimum touch target. A destructive
                // action that is hard to hit is also hard to hit on purpose.
                minimumSize: const Size.fromHeight(48),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
