import 'package:flutter/material.dart';

import '../theme.dart';
import 'glass/glass.dart';

/// Settings → Appearance: Light / Dark / System theme, plus accent colour.
/// Changes apply instantly and persist on the device (ThemeController).
class AppearanceSection extends StatelessWidget {
  const AppearanceSection({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = ThemeController.instance;
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            GlassCard(
              radius: 22,
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Theme', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
                  const SizedBox(height: 2),
                  Text(
                    'Choose how Office Tracker looks on this device.',
                    style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      for (final m in const [ThemeMode.light, ThemeMode.dark, ThemeMode.system]) ...[
                        if (m != ThemeMode.light) const SizedBox(width: 10),
                        Expanded(child: _ModeOption(mode: m, selected: controller.mode == m)),
                      ],
                    ],
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Icon(Icons.info_outline_rounded, size: 13, color: AppColors.textTertiary),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          "System follows your phone's own light or dark setting.",
                          style: TextStyle(fontSize: 11, color: AppColors.textTertiary),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            GlassCard(
              radius: 22,
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Accent colour', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
                  const SizedBox(height: 2),
                  Text(
                    'Used for progress, buttons and highlights.',
                    style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                  ),
                  const SizedBox(height: 14),
                  Wrap(
                    spacing: 12,
                    runSpacing: 12,
                    children: [
                      for (final a in AccentChoice.values)
                        _AccentSwatch(accent: a, selected: controller.accent == a),
                    ],
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _ModeOption extends StatelessWidget {
  final ThemeMode mode;
  final bool selected;
  const _ModeOption({required this.mode, required this.selected});

  String get _label => switch (mode) {
        ThemeMode.light => 'Light',
        ThemeMode.dark => 'Dark',
        ThemeMode.system => 'System',
      };

  @override
  Widget build(BuildContext context) {
    final light = AppPalette.build(Brightness.light, ThemeController.instance.accent);
    final dark = AppPalette.build(Brightness.dark, ThemeController.instance.accent);

    Widget preview;
    switch (mode) {
      case ThemeMode.light:
        preview = _miniScreen(light.bg, light.cardRaised);
      case ThemeMode.dark:
        preview = _miniScreen(dark.bg, dark.cardRaised);
      case ThemeMode.system:
        preview = Row(
          children: [
            Expanded(child: _miniScreen(light.bg, light.cardRaised, right: false)),
            Expanded(child: _miniScreen(dark.bg, dark.cardRaised, left: false)),
          ],
        );
    }

    return Semantics(
      button: true,
      selected: selected,
      label: '$_label theme',
      child: InkWell(
        onTap: () => ThemeController.instance.setMode(mode),
        borderRadius: BorderRadius.circular(16),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            color: selected ? AppColors.primary.withValues(alpha: 0.10) : AppColors.cardRaised,
            border: Border.all(
              color: selected ? AppColors.primary : AppColors.glassBorder,
              width: selected ? 2 : 1,
            ),
          ),
          child: Column(
            children: [
              SizedBox(height: 56, child: preview),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (selected) ...[
                    Icon(Icons.check_circle_rounded, size: 14, color: AppColors.primaryLight),
                    const SizedBox(width: 4),
                  ],
                  Text(
                    _label,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                      color: selected ? AppColors.primaryLight : AppColors.textSecondary,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _miniScreen(Color bg, Color card, {bool left = true, bool right = true}) {
    return Container(
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.horizontal(
          left: left ? const Radius.circular(10) : Radius.zero,
          right: right ? const Radius.circular(10) : Radius.zero,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(height: 16, decoration: BoxDecoration(color: card, borderRadius: BorderRadius.circular(4))),
          const SizedBox(height: 5),
          FractionallySizedBox(
            widthFactor: 0.7,
            child: Container(height: 10, decoration: BoxDecoration(color: card, borderRadius: BorderRadius.circular(3))),
          ),
        ],
      ),
    );
  }
}

class _AccentSwatch extends StatelessWidget {
  final AccentChoice accent;
  final bool selected;
  const _AccentSwatch({required this.accent, required this.selected});

  @override
  Widget build(BuildContext context) {
    final p = AppPalette.build(AppColors.palette.brightness, accent);
    final name = accent.name[0].toUpperCase() + accent.name.substring(1);
    return Semantics(
      button: true,
      selected: selected,
      label: '$name accent',
      child: InkWell(
        onTap: () => ThemeController.instance.setAccent(accent),
        customBorder: const CircleBorder(),
        child: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: LinearGradient(colors: [p.primary, p.accentEnd]),
            border: Border.all(color: AppColors.bg, width: 3),
            boxShadow: selected ? [BoxShadow(color: p.primary, spreadRadius: 2)] : null,
          ),
          child: selected ? const Icon(Icons.check_rounded, color: AppColors.onAccent, size: 20) : null,
        ),
      ),
    );
  }
}
