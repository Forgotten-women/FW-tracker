import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../theme.dart';
import 'documents_screen.dart';
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
  final _api = ApiClient();

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
      const WarningsScreen(),
      DocumentsScreen(api: _api),
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
          NavigationDestination(
            icon: Icon(Icons.folder_outlined),
            selectedIcon: Icon(Icons.folder, color: AppColors.teal),
            label: 'Documents',
          ),
        ],
      ),
    );
  }
}

