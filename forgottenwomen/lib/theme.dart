import 'package:flutter/material.dart';

class AppColors {
  static const teal = Color(0xFF0F766E);
  static const tealDark = Color(0xFF047857);
  static const slate = Color(0xFF334155);
  static const slateDark = Color(0xFF1E293B);
  static const surface = Color(0xFFF8FAFC);
  static const amber = Color(0xFFB45309);
}

ThemeData buildTheme() => ThemeData(
      colorScheme: ColorScheme.fromSeed(
        seedColor: AppColors.teal,
        brightness: Brightness.light,
      ),
      scaffoldBackgroundColor: AppColors.surface,
      useMaterial3: true,
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.white,
        elevation: 0.5,
        titleTextStyle: TextStyle(
          color: AppColors.slateDark,
          fontSize: 18,
          fontWeight: FontWeight.bold,
        ),
        iconTheme: IconThemeData(color: AppColors.slateDark),
      ),
      inputDecorationTheme: const InputDecorationTheme(
        border: OutlineInputBorder(),
      ),
    );
