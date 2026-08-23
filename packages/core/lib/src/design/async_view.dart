import 'package:flutter/material.dart';
import 'package:rideapp_core/src/design/theme.dart';
import 'package:rideapp_core/src/design/widgets.dart';
import 'package:rideapp_core/src/l10n/strings.dart';

/// The four states, made structural.
///
/// The brief requires every screen to handle Loading, Empty, Error and Success.
/// The audit found Loading and Error broadly present and **Empty missing almost
/// everywhere** — which is the predictable outcome of asking each screen to
/// remember four cases by hand.
///
/// So it is not asked by hand. `AsyncView` takes a [ViewState] and the builders
/// for each case are REQUIRED parameters. A screen that forgets the empty state
/// does not render an accidentally-blank page; it fails to compile.
///
/// That is the difference between a convention and a guarantee.
sealed class ViewState<T> {
  const ViewState();

  const factory ViewState.loading() = LoadingState<T>;
  const factory ViewState.empty() = EmptyState<T>;
  const factory ViewState.error(String message, {bool canRetry}) = ErrorState<T>;
  const factory ViewState.success(T data) = SuccessState<T>;

  /// Build a state from a nullable result, collapsing "loaded but nothing
  /// there" into [EmptyState] rather than a success carrying nothing — which
  /// is how a blank screen with no explanation gets shipped.
  static ViewState<List<T>> fromList<T>(List<T>? items) {
    if (items == null) return ViewState<List<T>>.loading();
    if (items.isEmpty) return ViewState<List<T>>.empty();
    return ViewState<List<T>>.success(items);
  }
}

final class LoadingState<T> extends ViewState<T> {
  const LoadingState();
}

final class EmptyState<T> extends ViewState<T> {
  const EmptyState();
}

final class ErrorState<T> extends ViewState<T> {
  const ErrorState(this.message, {this.canRetry = true});

  final String message;

  /// False for errors retrying cannot fix — a suspended account, a 403.
  /// Showing a retry button there teaches users the button does nothing.
  final bool canRetry;
}

final class SuccessState<T> extends ViewState<T> {
  const SuccessState(this.data);

  final T data;
}

/// Renders exactly one of the four states.
///
/// [empty] and [onRetry] are required, not optional-with-a-default. A default
/// would let a screen silently inherit a generic "nothing here" that says
/// nothing useful, which is barely better than a blank page.
class AsyncView<T> extends StatelessWidget {
  const AsyncView({
    required this.state,
    required this.success,
    required this.empty,
    required this.onRetry,
    super.key,
    this.loading,
  });

  final ViewState<T> state;
  final Widget Function(BuildContext context, T data) success;

  /// What to show when the request succeeded and there is nothing to show.
  /// Required, because "no rides yet" and "no drivers nearby" mean very
  /// different things to the person reading them.
  final Widget Function(BuildContext context) empty;

  /// Required so that a retryable error always has a way out.
  final VoidCallback onRetry;

  final Widget Function(BuildContext context)? loading;

  @override
  Widget build(BuildContext context) {
    return switch (state) {
      LoadingState<T>() => loading?.call(context) ?? const _DefaultLoading(),
      EmptyState<T>() => empty(context),
      ErrorState<T>(:final message, :final canRetry) => _ErrorView(
          message: message,
          onRetry: canRetry ? onRetry : null,
        ),
      SuccessState<T>(:final data) => success(context, data),
    };
  }
}

class _DefaultLoading extends StatelessWidget {
  const _DefaultLoading();

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Semantics(
      // Announced to a screen reader; a bare spinner is silent to one.
      label: strings.loading,
      child: const Padding(
        padding: EdgeInsetsDirectional.all(AppSpacing.xl),
        child: Center(child: CircularProgressIndicator()),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);

    return Padding(
      padding: const EdgeInsetsDirectional.all(AppSpacing.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, size: 48, color: AppColors.danger),
          const SizedBox(height: AppSpacing.md),
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          if (onRetry != null) ...[
            const SizedBox(height: AppSpacing.lg),
            PrimaryButton(label: strings.retry, onPressed: onRetry),
          ],
        ],
      ),
    );
  }
}

/// A reusable empty state, so each screen supplies only its own wording.
class EmptyView extends StatelessWidget {
  const EmptyView({
    required this.message,
    super.key,
    this.icon = Icons.inbox_outlined,
    this.action,
  });

  final String message;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsetsDirectional.all(AppSpacing.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 48, color: AppColors.textSecondary),
          const SizedBox(height: AppSpacing.md),
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context)
                .textTheme
                .bodyMedium
                ?.copyWith(color: AppColors.textSecondary),
          ),
          if (action != null) ...[const SizedBox(height: AppSpacing.lg), action!],
        ],
      ),
    );
  }
}
