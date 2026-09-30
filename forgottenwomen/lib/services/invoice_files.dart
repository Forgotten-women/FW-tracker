// Where a downloaded Word invoice lives on the phone: one folder in the
// app's temp directory, emptied each time another copy is saved, so pay
// details don't pile up on the device.

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

class InvoiceFiles {
  InvoiceFiles._();

  static const folderName = 'invoices';

  /// The folder, under [base] (the app's temp directory by default).
  static Future<Directory> folder({Directory? base}) async {
    final root = base ?? await getTemporaryDirectory();
    return Directory('${root.path}${Platform.pathSeparator}$folderName');
  }

  /// Deletes every invoice file saved earlier. Never throws.
  static Future<void> purge({Directory? base}) async {
    try {
      final dir = await folder(base: base);
      if (!await dir.exists()) return;
      await for (final entity in dir.list()) {
        try {
          await entity.delete(recursive: true);
        } catch (e) {
          // A file another app still has open; the next save tries again.
          debugPrint('InvoiceFiles.purge: $e');
        }
      }
    } catch (e) {
      debugPrint('InvoiceFiles.purge error: $e');
    }
  }

  /// Clears older copies, then writes [bytes] as [fileName]. The name has
  /// already been made safe (InvoiceDocx.fileNameFrom).
  static Future<File> save(Uint8List bytes, String fileName, {Directory? base}) async {
    await purge(base: base);
    final dir = await folder(base: base);
    await dir.create(recursive: true);
    final file = File('${dir.path}${Platform.pathSeparator}$fileName');
    await file.writeAsBytes(bytes, flush: true);
    return file;
  }
}
