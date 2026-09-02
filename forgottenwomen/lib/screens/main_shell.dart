import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../services/notification_service.dart';
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

  @override
  void initState() {
    super.initState();
    NotificationService().onNotificationTapped = _handleNotificationTap;
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
    _api.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // IndexedStack keeps each tab's state alive when switching
    final tabs = [
      HomeScreen(onSignedOut: widget.onSignedOut),
      const LeaveScreen(),
      const SalaryScreen(),
      const WarningsScreen(),
      DocumentsScreen(api: _api),
    ];

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
                  destinations: const [
                    NavigationRailDestination(
                      icon: Icon(Icons.home_outlined),
                      selectedIcon: Icon(Icons.home, color: AppColors.teal),
                      label: Text('Home'),
                    ),
                    NavigationRailDestination(
                      icon: Icon(Icons.event_available_outlined),
                      selectedIcon: Icon(Icons.event_available, color: AppColors.teal),
                      label: Text('Leave'),
                    ),
                    NavigationRailDestination(
                      icon: Icon(Icons.account_balance_wallet_outlined),
                      selectedIcon: Icon(Icons.account_balance_wallet, color: AppColors.teal),
                      label: Text('Salary'),
                    ),
                    NavigationRailDestination(
                      icon: Icon(Icons.gavel_outlined),
                      selectedIcon: Icon(Icons.gavel, color: AppColors.teal),
                      label: Text('Warnings'),
                    ),
                    NavigationRailDestination(
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
            destinations: const [
              NavigationDestination(
                icon: Icon(Icons.home_outlined),
                selectedIcon: Icon(Icons.home, color: AppColors.teal),
                label: 'Home',
              ),
              NavigationDestination(
                icon: Icon(Icons.event_available_outlined),
                selectedIcon: Icon(Icons.event_available, color: AppColors.teal),
                label: 'Leave',
              ),
              NavigationDestination(
                icon: Icon(Icons.account_balance_wallet_outlined),
                selectedIcon: Icon(Icons.account_balance_wallet, color: AppColors.teal),
                label: 'Salary',
              ),
              NavigationDestination(
                icon: Icon(Icons.gavel_outlined),
                selectedIcon: Icon(Icons.gavel, color: AppColors.teal),
                label: 'Warnings',
              ),
              NavigationDestination(
                icon: Icon(Icons.folder_outlined),
                selectedIcon: Icon(Icons.folder, color: AppColors.teal),
                label: 'Documents',
              ),
            ],
          ),
        );
      },
    );
  }
}


