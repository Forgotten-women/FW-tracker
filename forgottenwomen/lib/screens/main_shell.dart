import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../blocs/home/home_bloc.dart';
import '../blocs/home/home_event.dart';
import '../blocs/home/home_state.dart';
import '../repositories/attendance_repository.dart';
import '../services/api_client.dart';
import '../services/notification_service.dart';
import '../services/offline_queue.dart';
import '../services/ota_service.dart';
import '../services/payslip_watcher.dart';
import '../widgets/glass/glass.dart';
import '../widgets/update_dialog.dart';
import '../theme.dart';
import 'documents_screen.dart';
import 'home_screen.dart';
import 'leave_screen.dart';
import 'salary_screen.dart';
import 'warnings_screen.dart';

class MainShell extends StatefulWidget {
  final VoidCallback onSignedOut;
  const MainShell({super.key, required this.onSignedOut});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _index = 0;
  final _api = ApiClient();
  final _otaService = OtaService();
  late final AttendanceRepository _attendanceRepo;
  late final HomeBloc _homeBloc;

  @override
  void initState() {
    super.initState();
    _attendanceRepo = AttendanceRepository(
      apiClient: _api,
      offlineQueue: OfflineQueue(),
    );
    _homeBloc = HomeBloc(repository: _attendanceRepo)..add(const HomeStarted());

    NotificationService().onNotificationTapped = _handleNotificationTap;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkOtaUpdate();
      _checkNotificationLaunch();
    });
  }

  Future<void> _checkNotificationLaunch() async {
    final payload = await NotificationService().checkLaunchPayload();
    if (mounted && payload != null) {
      _handleNotificationTap(payload);
    }
  }

  Future<void> _checkOtaUpdate() async {
    try {
      final info = await _otaService.checkForUpdate();
      if (mounted && info != null && info.updateAvailable) {
        UpdateDialog.show(context, info);
      }
    } catch (_) {}
  }

  void _handleNotificationTap(String? payload) {
    if (!mounted || payload == null) return;
    final clean = payload.toUpperCase();
    if (clean.contains('LEAVE')) {
      setState(() => _index = 1);
    } else if (clean.contains('SALARY') || clean.contains('PAYROLL') || clean.contains('PAY')) {
      // Includes PayslipWatcher's 'PAYSLIP'. The salary tab was built at
      // launch, so ask it to reload: the payslip may be newer than its data.
      PayslipWatcher.refreshRequests.value++;
      setState(() => _index = 2);
    } else if (clean.contains('WARN')) {
      setState(() => _index = 3);
    } else if (clean.contains('DOC')) {
      setState(() => _index = 4);
    } else {
      setState(() => _index = 0);
    }
  }

  @override
  void dispose() {
    _homeBloc.close();
    _api.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tabs = [
      HomeScreen(onSignedOut: widget.onSignedOut),
      const LeaveScreen(),
      const SalaryScreen(),
      const WarningsScreen(),
      DocumentsScreen(api: _api),
    ];

    return RepositoryProvider.value(
      value: _attendanceRepo,
      child: BlocProvider.value(
        value: _homeBloc,
        child: BlocBuilder<HomeBloc, HomeState>(
          builder: (context, homeState) {
            int unreadCount = 0;
            if (homeState is HomeLoaded) {
              unreadCount = homeState.summary.unreadNotificationsCount;
            }

            final navItems = [
              const GlassNavItem(icon: Icons.home_outlined, activeIcon: Icons.home_rounded, label: 'Home'),
              const GlassNavItem(icon: Icons.event_available_outlined, activeIcon: Icons.event_available_rounded, label: 'Leave'),
              const GlassNavItem(icon: Icons.account_balance_wallet_outlined, activeIcon: Icons.account_balance_wallet_rounded, label: 'Salary'),
              GlassNavItem(icon: Icons.gavel_outlined, activeIcon: Icons.gavel_rounded, label: 'Warnings', badge: unreadCount),
              const GlassNavItem(icon: Icons.folder_outlined, activeIcon: Icons.folder_rounded, label: 'Documents'),
            ];

            return LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 720;

                if (isWide) {
                  return AmbientBackground(
                    child: Scaffold(
                      backgroundColor: Colors.transparent,
                      body: Row(
                        children: [
                          NavigationRail(
                            selectedIndex: _index,
                            onDestinationSelected: (i) => setState(() => _index = i),
                            labelType: NavigationRailLabelType.all,
                            destinations: [
                              for (final item in navItems)
                                NavigationRailDestination(
                                  icon: item.badge > 0
                                      ? Badge.count(
                                          count: item.badge,
                                          backgroundColor: AppColors.danger,
                                          textColor: AppColors.onAccent,
                                          child: Icon(item.icon),
                                        )
                                      : Icon(item.icon),
                                  selectedIcon: Icon(item.activeIcon),
                                  label: Text(item.label),
                                ),
                            ],
                          ),
                          VerticalDivider(thickness: 1, width: 1, color: AppColors.border),
                          Expanded(
                            child: Center(
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(maxWidth: 800),
                                child: IndexedStack(index: _index, children: tabs),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                }

                // The nav floats over the ambient background rather than over
                // tab content (no extendBody), so lists never scroll behind it
                // and need no per-screen bottom padding.
                return AmbientBackground(
                  child: Scaffold(
                    backgroundColor: Colors.transparent,
                    body: IndexedStack(index: _index, children: tabs),
                    bottomNavigationBar: SafeArea(
                      top: false,
                      child: GlassNavBar(
                        currentIndex: _index,
                        onTap: (i) => setState(() => _index = i),
                        items: navItems,
                      ),
                    ),
                  ),
                );
              },
            );
          },
        ),
      ),
    );
  }
}
