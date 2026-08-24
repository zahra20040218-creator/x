/// Shared Flutter code for the rider and driver apps.
///
/// CLAUDE.md §1: models, API client and design system live here, because
/// duplicated widget code between the two apps is a defect.
library rideapp_core;

export 'src/api/api_client.dart';
export 'src/api/api_exception.dart';
export 'src/api/token_store.dart';
export 'src/design/async_view.dart';
export 'src/design/theme.dart';
export 'src/design/widgets.dart';
export 'src/l10n/strings.dart';
export 'src/location/location_buffer.dart';
export 'src/models/models.dart';
export 'src/money/iqd.dart';
export 'src/maps/map_state.dart';
export 'src/maps/location_gate.dart';
export 'src/maps/map_picker_view.dart';
export 'src/l10n/dates.dart';
export 'src/money/earnings.dart';
export 'src/push/push_registrar.dart';
export 'src/push/firebase_push_token_source.dart';
