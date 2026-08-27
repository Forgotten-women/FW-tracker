import 'package:flutter/material.dart';

import 'screens/enroll_screen.dart';
import 'screens/home_screen.dart';
import 'services/presence_service.dart';
import 'services/token_store.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Must happen before any UI, so the background isolate is registered even
  // when the app is launched by the OS rather than by the user.
  await PresenceService.configure();
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
    final enrolled = await _store.isEnrolled;
    if (!mounted) return;
    setState(() => _enrolled = enrolled);
    // Resume reporting after a reboot or an app update.
    if (enrolled) await PresenceService.start();
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
        true => HomeScreen(onSignedOut: () => setState(() => _enrolled = false)),
      },
    );
  }
}
