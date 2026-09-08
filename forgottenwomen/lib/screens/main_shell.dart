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
    });
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

            return LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 720;

                if (isWide) {
                  return Scaffold(
                    body: Row(
                      children: [
                        NavigationRail(
                          selectedIndex: _index,
                          onDestinationSelected: (i) => setState(() => _index = i),
                          labelType: NavigationRailLabelType.all,
                          backgroundColor: AppColors.surfaceDark,
                          indicatorColor: AppColors.teal.withValues(alpha: 0.15),
                          destinations: [
                            const NavigationRailDestination(
                              icon: Icon(Icons.home_outlined),
                              selectedIcon: Icon(Icons.home, color: AppColors.teal),
                              label: Text('Home'),
                            ),
                            const NavigationRailDestination(
                              icon: Icon(Icons.event_available_outlined),
                              selectedIcon: Icon(Icons.event_available, color: AppColors.teal),
                              label: Text('Leave'),
                            ),
                            const NavigationRailDestination(
                              icon: Icon(Icons.account_balance_wallet_outlined),
                              selectedIcon: Icon(Icons.account_balance_wallet, color: AppColors.teal),
                              label: Text('Salary'),
                            ),
                            NavigationRailDestination(
                              icon: unreadCount > 0
                                  ? Badge.count(
                                      count: unreadCount,
                                      backgroundColor: AppColors.amber,
                                      textColor: Colors.black,
                                      child: const Icon(Icons.gavel_outlined),
                                    )
                                  : const Icon(Icons.gavel_outlined),
                              selectedIcon: const Icon(Icons.gavel, color: AppColors.teal),
                              label: const Text('Warnings'),
                            ),
                            const NavigationRailDestination(
                              icon: Icon(Icons.folder_outlined),
                              selectedIcon: Icon(Icons.folder, color: AppColors.teal),
                              label: Text('Documents'),
                            ),
                          ],
                        ),
                        const VerticalDivider(thickness: 1, width: 1, color: AppColors.border),
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
                  );
                }

                return Scaffold(
                  body: IndexedStack(index: _index, children: tabs),
                  bottomNavigationBar: NavigationBar(
                    selectedIndex: _index,
                    onDestinationSelected: (i) => setState(() => _index = i),
                    indicatorColor: AppColors.teal.withValues(alpha: 0.15),
                    destinations: [
                      const NavigationDestination(
                        icon: Icon(Icons.home_outlined),
                        selectedIcon: Icon(Icons.home, color: AppColors.teal),
                        label: 'Home',
                      ),
                      const NavigationDestination(
                        icon: Icon(Icons.event_available_outlined),
                        selectedIcon: Icon(Icons.event_available, color: AppColors.teal),
                        label: 'Leave',
                      ),
                      const NavigationDestination(
                        icon: Icon(Icons.account_balance_wallet_outlined),
                        selectedIcon: Icon(Icons.account_balance_wallet, color: AppColors.teal),
                        label: 'Salary',
                      ),
                      NavigationDestination(
                        icon: unreadCount > 0
                            ? Badge.count(
                                count: unreadCount,
                                backgroundColor: AppColors.amber,
                                textColor: Colors.black,
                                child: const Icon(Icons.gavel_outlined),
                              )
                            : const Icon(Icons.gavel_outlined),
                        selectedIcon: const Icon(Icons.gavel, color: AppColors.teal),
                        label: 'Warnings',
                      ),
                      const NavigationDestination(
                        icon: Icon(Icons.folder_outlined),
                        selectedIcon: Icon(Icons.folder, color: AppColors.teal),
                        label: 'Documents',
                      ),
                    ],
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
