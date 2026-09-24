import 'package:flutter/material.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

import 'screens/enroll_screen.dart';
import 'screens/main_shell.dart';
import 'services/device_probe.dart';
import 'services/notification_service.dart';
import 'services/presence_service.dart';
import 'services/token_store.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await dotenv.load(fileName: ".env");
  } catch (e) {
    debugPrint('dotenv.load notice: $e');
  }
  await ThemeController.instance.load();
  try {
    await NotificationService().initialize();
  } catch (e) {
    debugPrint('NotificationService.initialize error: $e');
  }
  try {
    await PresenceService.configure();
  } catch (e) {
    debugPrint('PresenceService.configure non-fatal error: $e');
  }
  try {
    await PresenceService.scheduleDailyResume();
  } catch (e) {
    debugPrint('PresenceService.scheduleDailyResume non-fatal error: $e');
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
    ThemeController.instance.addListener(_onThemeChanged);
    _check();
  }

  @override
  void dispose() {
    ThemeController.instance.removeListener(_onThemeChanged);
    super.dispose();
  }

  // AppColors getters are read inside build(), so widgets only pick up a new
  // palette when they rebuild. Marking every element dirty repaints the whole
  // tree once, keeping all State (blocs, scroll positions, open tabs) intact.
  void _onThemeChanged() {
    void markAll(Element e) {
      e.markNeedsBuild();
      e.visitChildren(markAll);
    }

    (context as Element).visitChildren(markAll);
    setState(() {});
  }

  Future<void> _check() async {
    try {
      final enrolled = await _store.isEnrolled;
      if (!mounted) return;
      setState(() => _enrolled = enrolled);
      if (enrolled) {
        // Re-request on every startup, not just at enrollment: this covers
        // devices that enrolled before this exemption request existed, and
        // any OEM that silently revokes the exemption after an app/OS
        // update.
        try {
          await DeviceProbe().ensureBatteryOptimizationExemption();
        } catch (_) {}
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
        null => Scaffold(
            body: Center(child: CircularProgressIndicator(color: AppColors.teal)),
          ),
        false => EnrollScreen(onEnrolled: () => setState(() => _enrolled = true)),
        true => MainShell(onSignedOut: () => setState(() => _enrolled = false)),
      },
    );
  }
}