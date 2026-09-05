import 'dart:io';

import 'package:rideapp_core/rideapp_core.dart';

/// File-backed buffer storage.
///
/// A file in the app's private support directory, NOT SharedPreferences.
/// SharedPreferences rewrites and re-parses an XML document on every write; the
/// buffer is rewritten every few seconds while driving and can hold thousands
/// of samples, which is exactly the shape it handles worst.
///
/// Writes go to a temp file and are then renamed. A rename is atomic on the
/// same filesystem, so a process kill mid-write — the normal way an Android
/// app dies — leaves the previous good buffer intact rather than a truncated
/// one that fails to parse.
class FileBufferStorage implements BufferStorage {
  FileBufferStorage(this.path);

  final String path;

  File get _file => File(path);
  File get _temp => File('$path.tmp');

  @override
  Future<String?> read() async {
    try {
      if (!_file.existsSync()) return null;
      return await _file.readAsString();
    } on FileSystemException {
      // Unreadable buffer: the caller treats a null as an empty buffer and
      // carries on. Losing history beats refusing to let the driver work.
      return null;
    }
  }

  @override
  Future<void> write(String contents) async {
    try {
      await _temp.writeAsString(contents, flush: true);
      await _temp.rename(path);
    } on FileSystemException {
      // Out of disk, or the directory vanished. The in-memory buffer is still
      // intact and will be retried on the next sample.
    }
  }

  @override
  Future<void> clear() async {
    try {
      if (_file.existsSync()) await _file.delete();
      if (_temp.existsSync()) await _temp.delete();
    } on FileSystemException {
      // Nothing useful to do; the next write overwrites it anyway.
    }
  }
}
