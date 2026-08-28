// Bottom-navigation shell for the enrolled employee. Spec section 32 lists the
// mobile navigation as Home, Attendance, Leave, Warnings, Documents, Profile,
// Notifications. The three built so far - Home (attendance), Leave and Warnings
// - are the ones with backend behind them; the rest are placeholders for later
// phases rather than dead tabs.

import 'package:flutter/material.dart';

import '../theme.dart';
import 'home_screen.dart';
import 'leave_screen.dart';
import 'warnings_screen.dart';

class MainShell extends StatefulWidget {
  final VoidCallback onSignedOut;
  const MainShell({super.key, required this.onSignedOut});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    // IndexedStack keeps each tab's state alive when switching, so the Home
    // tab's presence polling is not torn down every time the employee checks
    // their leave.
    final tabs = [
      HomeScreen(onSignedOut: widget.onSignedOut),
      const LeaveScreen(),
      const WarningsScreen(),
    ];

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
            icon: Icon(Icons.gavel_outlined),
            selectedIcon: Icon(Icons.gavel, color: AppColors.teal),
            label: 'Warnings',
          ),
        ],
      ),
    );
  }
}
