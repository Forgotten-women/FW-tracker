import 'package:flutter/material.dart';

import 'screens/enroll_screen.dart';
import 'screens/main_shell.dart';
import 'services/presence_service.dart';
import 'services/token_store.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await PresenceService.configure();
  } catch (e) {
    debugPrint('PresenceService.configure non-fatal error: $e');
  }
  runApp(const OfficeTrackerApp());
}

class OfficeTrackerApp extends StatefulWidget {
  const OfficeTrackerApp({super.key});

  @override
  State<OfficeTrackerApp> createState() => _OfficeTrackerAppState();
}

class _OfficeTrackerAppState extends State<OfficeTrackerApp> {
  final _store = TokenStore();
  bool? _enrolled;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    try {
      final enrolled = await _store.isEnrolled;
      if (!mounted) return;
      setState(() => _enrolled = enrolled);
      if (enrolled) {
        try {
          await PresenceService.start();
        } catch (e) {
          debugPrint('PresenceService.start error: $e');
        }
      }
    } catch (e) {
      debugPrint('Enrollment check failed: $e');
      if (!mounted) return;
      setState(() => _enrolled = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Office Tracker',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: switch (_enrolled) {
        null => const Scaffold(
            body: Center(child: CircularProgressIndicator(color: AppColors.teal)),
          ),
        false => EnrollScreen(onEnrolled: () => setState(() => _enrolled = true)),
        true => MainShell(onSignedOut: () => setState(() => _enrolled = false)),
      },
    );
  }
}