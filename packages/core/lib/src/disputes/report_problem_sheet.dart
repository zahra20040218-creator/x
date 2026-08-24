import 'package:flutter/material.dart';

import 'package:rideapp_core/src/api/api_client.dart';
import 'package:rideapp_core/src/api/api_exception.dart';
import 'package:rideapp_core/src/design/theme.dart';
import 'package:rideapp_core/src/design/widgets.dart';
import 'package:rideapp_core/src/l10n/strings.dart';
import 'package:rideapp_core/src/models/models.dart';

/// Report a problem with a ride.
///
/// Lives in `packages/core` rather than in either app because both need it:
/// a rider disputes the fare, a driver reports a rider who never appeared.
/// CLAUDE.md §1 treats the duplicated version of this as a defect.
///
/// Returns the [Dispute] on success and null if the user backed out, so the
/// caller can show the reference number without re-querying.
Future<Dispute?> showReportProblemSheet({
  required BuildContext context,
  required ApiClient api,
  required String rideId,
  required List<DisputeReason> reasons,
}) =>
    showModalBottomSheet<Dispute>(
      context: context,
      isScrollControlled: true,
      builder: (context) => Padding(
        // Lifts the sheet clear of the keyboard. Without this the description
        // field is behind it on most handsets and the submit button is
        // unreachable.
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(context).viewInsets.bottom,
        ),
        child: _ReportProblemSheet(api: api, rideId: rideId, reasons: reasons),
      ),
    );

class _ReportProblemSheet extends StatefulWidget {
  const _ReportProblemSheet({
    required this.api,
    required this.rideId,
    required this.reasons,
  });

  final ApiClient api;
  final String rideId;

  /// Which reasons this party can pick. A driver has no use for
  /// `driverNoShow`, and offering it invites a nonsense report.
  final List<DisputeReason> reasons;

  @override
  State<_ReportProblemSheet> createState() => _ReportProblemSheetState();
}

class _ReportProblemSheetState extends State<_ReportProblemSheet> {
  DisputeReason? _reason;
  final _description = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final reason = _reason;
    if (reason == null) return;

    setState(() {
      _submitting = true;
      _error = null;
    });

    try {
      final dispute = await widget.api.openDispute(
        rideId: widget.rideId,
        reason: reason,
        description: _description.text.trim(),
      );
      if (!mounted) return;
      Navigator.of(context).pop(dispute);
    } on ApiException catch (error) {
      if (!mounted) return;
      // Shown in the sheet rather than as a toast behind it: the user still
      // has a filled-in form here and should not have to retype it.
      setState(() => _error = error.detail ?? error.problem.slug);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              strings.reportProblemPrompt,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.sm),

            // RadioGroup rather than per-tile groupValue/onChanged: those were
            // deprecated after Flutter 3.32, and the group owns the selection.
            RadioGroup<DisputeReason>(
              groupValue: _reason,
              // RadioGroup.onChanged is non-nullable, so the in-flight case is
              // guarded here rather than by passing null; IgnorePointer below
              // is what actually stops the taps.
              onChanged: (value) {
                if (_submitting) return;
                setState(() => _reason = value);
              },
              child: IgnorePointer(
                ignoring: _submitting,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final reason in widget.reasons)
                      RadioListTile<DisputeReason>(
                        value: reason,
                        title: Text(strings.disputeReasonLabel(reason)),
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                      ),
                  ],
                ),
              ),
            ),

            const SizedBox(height: AppSpacing.sm),
            TextField(
              controller: _description,
              enabled: !_submitting,
              maxLines: 3,
              // The server caps the column at 2000; stopping the user here is
              // kinder than a 422 after they have written an essay.
              maxLength: 2000,
              decoration: InputDecoration(
                labelText: strings.describeProblemOptional,
                errorText: _error,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),

            PrimaryButton(
              label: strings.submitReport,
              // Disabled until a reason is chosen: reasonCode is required by
              // the server enum and there is no sensible default.
              onPressed: _reason == null || _submitting ? null : _submit,
              busy: _submitting,
            ),
          ],
        ),
      ),
    );
  }
}
