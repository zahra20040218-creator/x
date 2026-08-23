import 'package:android_intent_plus/android_intent.dart';
import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:rideapp_core/rideapp_core.dart';
import 'package:rideapp_driver/location/location_service.dart';

/// The onboarding screen CLAUDE.md §5.3 requires:
///
///   "Request battery optimization exemption at onboarding, with an
///    explanatory screen."
///
/// The explanation is the load-bearing part. A driver who taps "deny" on an
/// unexplained Android system dialog has silently broken their own app, and
/// neither they nor support will connect the two events. So each step states
/// the CONSEQUENCE in the driver's own terms — "your location stops updating
/// and the rider thinks you have not moved" — rather than asking for a
/// permission by name.
class BatteryExemptionScreen extends StatefulWidget {
  const BatteryExemptionScreen({required this.onComplete, super.key});

  final VoidCallback onComplete;

  @override
  State<BatteryExemptionScreen> createState() => _BatteryExemptionScreenState();
}

enum _Step { foreground, background, battery, done }

class _BatteryExemptionScreenState extends State<BatteryExemptionScreen> {
  _Step _step = _Step.foreground;
  bool _busy = false;

  /// Set when a permission request comes back denied.
  ///
  /// Without this the screen silently did nothing on a denial: the driver
  /// tapped, Android refused, and the same screen stared back with no
  /// explanation and no way forward. They would conclude the app is broken -
  /// and they would be right.
  String? _error;

  Future<void> _advance() async {
    setState(() {
      _busy = true;
      _error = null;
    });

    final strings = AppStrings.of(context);

    try {
      switch (_step) {
        case _Step.foreground:
          if (await LocationPermissions.requestForeground()) {
            setState(() => _step = _Step.background);
          } else {
            setState(() => _error = strings.permissionDenied);
          }

        case _Step.background:
          // Android shows this as a SETTINGS PAGE, not a dialog. The screen
          // before it is what stops the driver simply backing out.
          if (await LocationPermissions.requestBackground()) {
            setState(() => _step = _Step.battery);
          } else {
            setState(() => _error = strings.backgroundLocationBody);
          }

        case _Step.battery:
          await _requestBatteryExemption();
          setState(() => _step = _Step.done);
          widget.onComplete();

        case _Step.done:
          widget.onComplete();
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Ask Android to exempt the app from Doze.
  ///
  /// Two routes, because OEMs differ: the plugin's own helper first, and the
  /// system intent as a fallback. On MIUI and One UI neither is guaranteed —
  /// which is exactly why `ACCEPTANCE_CHECKLIST.md` check 2 says to repeat the
  /// screen-off drive on a Xiaomi and a Samsung specifically.
  Future<void> _requestBatteryExemption() async {
    if (await FlutterForegroundTask.isIgnoringBatteryOptimizations) return;

    await FlutterForegroundTask.requestIgnoreBatteryOptimization();

    if (!await FlutterForegroundTask.isIgnoringBatteryOptimizations) {
      const intent = AndroidIntent(
        action: 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
      );
      await intent.launch();
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    final (title, body, cta) = switch (_step) {
      _Step.foreground => (
          strings.locationPermissionTitle,
          strings.locationPermissionBody,
          strings.ok,
        ),
      _Step.background => (
          strings.backgroundLocationTitle,
          strings.backgroundLocationBody,
          strings.ok,
        ),
      _Step.battery => (
          strings.batteryExemptionTitle,
          strings.batteryExemptionBody,
          strings.batteryExemptionCta,
        ),
      _Step.done => (strings.youAreOnline, '', strings.ok),
    };

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsetsDirectional.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: AppSpacing.xl),
              _StepIndicator(step: _step),
              const SizedBox(height: AppSpacing.xl),
              Icon(
                switch (_step) {
                  _Step.foreground => Icons.my_location,
                  _Step.background => Icons.location_on_outlined,
                  _Step.battery => Icons.battery_saver_outlined,
                  _Step.done => Icons.check_circle_outline,
                },
                size: 64,
                color: AppColors.primary,
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(title, style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: AppSpacing.md),
              Text(body, style: Theme.of(context).textTheme.bodyMedium),

              // The ERROR state. A denial is the most likely outcome of this
              // screen, not an edge case, so it gets a visible explanation and
              // the button below doubles as the retry.
              if (_error != null) ...[
                const SizedBox(height: AppSpacing.md),
                StatusBanner(message: _error!, tone: BannerTone.warning),
              ],

              const Spacer(),
              PrimaryButton(
                label: _error == null ? cta : strings.retry,
                onPressed: _advance,
                busy: _busy,
              ),
              const SizedBox(height: AppSpacing.md),
            ],
          ),
        ),
      ),
    );
  }
}

class _StepIndicator extends StatelessWidget {
  const _StepIndicator({required this.step});

  final _Step step;

  @override
  Widget build(BuildContext context) {
    final index = _Step.values.indexOf(step);

    return Row(
      children: List.generate(3, (i) {
        return Expanded(
          child: Container(
            height: 4,
            margin: const EdgeInsetsDirectional.only(end: AppSpacing.xs),
            decoration: BoxDecoration(
              color: i <= index ? AppColors.primary : AppColors.divider,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        );
      }),
    );
  }
}
