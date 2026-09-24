import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../theme.dart';

/// Soft colour orbs behind every screen. Glass cards are translucent, so they
/// read as "frosted" only when something colourful sits behind them.
class AmbientBackground extends StatelessWidget {
  final Widget child;
  const AmbientBackground({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final orbs = AppColors.orbs;
    return ColoredBox(
      color: AppColors.bg,
      child: Stack(
        children: [
          Positioned.fill(
            child: RepaintBoundary(
              child: Stack(
                children: [
                  _orb(orbs[0], top: -110, left: -90, size: 320),
                  _orb(orbs[1], top: 240, right: -130, size: 340),
                  _orb(orbs[2], bottom: -60, left: -120, size: 340),
                ],
              ),
            ),
          ),
          Positioned.fill(child: child),
        ],
      ),
    );
  }

  Widget _orb(Color c, {double? top, double? left, double? right, double? bottom, required double size}) {
    return Positioned(
      top: top,
      left: left,
      right: right,
      bottom: bottom,
      child: IgnorePointer(
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: RadialGradient(colors: [c, c.withValues(alpha: 0)]),
          ),
        ),
      ),
    );
  }
}

/// Frosted-glass surface.
///
/// [blur] runs a real backdrop blur — visually best, but expensive on low-end
/// Android GPUs, so it's reserved for one or two hero surfaces per screen
/// (the shift ring card, the floating nav). Everything else uses the
/// translucent fill alone, which looks nearly identical over the ambient
/// background and scrolls smoothly.
class GlassCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final bool blur;
  final bool strong;
  final Color? tint;
  final Color? borderColor;
  final VoidCallback? onTap;

  const GlassCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.radius = 22,
    this.blur = false,
    this.strong = false,
    this.tint,
    this.borderColor,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final br = BorderRadius.circular(radius);
    final fill = tint ?? (strong ? AppColors.glassFillStrong : AppColors.glassFill);
    final sheenTop = AppColors.isDark
        ? fill.withValues(alpha: (fill.a + 0.05).clamp(0.0, 1.0))
        : fill.withValues(alpha: (fill.a + 0.12).clamp(0.0, 1.0));

    Widget surface = Container(
      padding: padding,
      decoration: BoxDecoration(
        borderRadius: br,
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [sheenTop, fill],
        ),
        border: Border.all(color: borderColor ?? AppColors.glassBorder),
      ),
      child: child,
    );

    if (onTap != null) {
      surface = Material(
        type: MaterialType.transparency,
        child: InkWell(onTap: onTap, borderRadius: br, child: surface),
      );
    }

    if (blur) {
      surface = BackdropFilter(
        filter: ui.ImageFilter.blur(sigmaX: 24, sigmaY: 24),
        child: surface,
      );
    }

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: br,
        boxShadow: [
          BoxShadow(
            color: AppColors.shadow,
            blurRadius: strong ? 36 : 24,
            offset: Offset(0, strong ? 14 : 8),
          ),
        ],
      ),
      child: ClipRRect(borderRadius: br, child: surface),
    );
  }
}

/// Small uppercase section heading.
class SectionLabel extends StatelessWidget {
  final String text;
  final Widget? trailing;
  const SectionLabel(this.text, {super.key, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              text.toUpperCase(),
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.0,
                color: AppColors.textTertiary,
              ),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// Coloured dot + label pill for presence / request states.
class StatusPill extends StatelessWidget {
  final String label;
  final Color tone;
  final bool glow;
  const StatusPill({super.key, required this.label, required this.tone, this.glow = true});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: tone.withValues(alpha: 0.32)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: tone,
              boxShadow: glow
                  ? [BoxShadow(color: tone.withValues(alpha: 0.35), spreadRadius: 3)]
                  : null,
            ),
          ),
          const SizedBox(width: 7),
          Text(
            label,
            style: TextStyle(
              color: tone,
              fontWeight: FontWeight.w800,
              fontSize: 11,
              letterSpacing: 0.6,
            ),
          ),
        ],
      ),
    );
  }
}

/// Rounded-square icon on a gradient fill, used for quick actions.
class GradientIconTile extends StatelessWidget {
  final IconData icon;
  final List<Color> colors;
  final double size;
  const GradientIconTile({super.key, required this.icon, required this.colors, this.size = 42});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.32),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: colors,
        ),
        boxShadow: [
          BoxShadow(
            color: colors.last.withValues(alpha: 0.35),
            blurRadius: 14,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Icon(icon, color: AppColors.onAccent, size: size * 0.45),
    );
  }
}

/// Circular progress ring with a gradient arc and arbitrary centre content.
class ProgressRing extends StatelessWidget {
  final double progress;
  final double size;
  final double stroke;
  final List<Color> colors;
  final Color? trackColor;
  final Widget? child;

  const ProgressRing({
    super.key,
    required this.progress,
    required this.colors,
    this.size = 200,
    this.stroke = 14,
    this.trackColor,
    this.child,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _RingPainter(
          progress: progress.clamp(0.0, 1.0),
          stroke: stroke,
          colors: colors,
          track: trackColor ?? AppColors.primary.withValues(alpha: 0.14),
        ),
        child: Center(child: child),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  final double progress;
  final double stroke;
  final List<Color> colors;
  final Color track;

  _RingPainter({
    required this.progress,
    required this.stroke,
    required this.colors,
    required this.track,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final arcRect = rect.deflate(stroke / 2);
    final trackPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = track;
    canvas.drawArc(arcRect, 0, math.pi * 2, false, trackPaint);

    if (progress <= 0) return;
    final sweep = math.pi * 2 * progress;
    final arcPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..shader = SweepGradient(
        startAngle: 0,
        endAngle: math.pi * 2,
        colors: colors,
        transform: const GradientRotation(-math.pi / 2),
      ).createShader(rect);
    canvas.drawArc(arcRect, -math.pi / 2, sweep, false, arcPaint);
  }

  @override
  bool shouldRepaint(covariant _RingPainter old) =>
      old.progress != progress ||
      old.stroke != stroke ||
      old.track != track ||
      old.colors != colors;
}

class GlassNavItem {
  final IconData icon;
  final IconData activeIcon;
  final String label;
  final int badge;
  const GlassNavItem({
    required this.icon,
    required this.activeIcon,
    required this.label,
    this.badge = 0,
  });
}

/// Floating, detached glass tab bar. The active tab expands into a gradient
/// pill with its label; the rest stay icon-only to keep five tabs readable at
/// phone width.
class GlassNavBar extends StatelessWidget {
  final int currentIndex;
  final ValueChanged<int> onTap;
  final List<GlassNavItem> items;

  const GlassNavBar({
    super.key,
    required this.currentIndex,
    required this.onTap,
    required this.items,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: GlassCard(
        blur: true,
        strong: true,
        radius: 26,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            for (var i = 0; i < items.length; i++) _buildItem(i),
          ],
        ),
      ),
    );
  }

  Widget _buildItem(int i) {
    final item = items[i];
    final active = i == currentIndex;
    final iconColor = active ? AppColors.onAccent : AppColors.textSecondary;

    Widget icon = Icon(active ? item.activeIcon : item.icon, size: 22, color: iconColor);
    if (item.badge > 0) {
      icon = Badge(
        label: Text('${item.badge}'),
        backgroundColor: AppColors.danger,
        textColor: AppColors.onAccent,
        child: icon,
      );
    }

    return Semantics(
      button: true,
      selected: active,
      label: item.label,
      child: InkWell(
        onTap: () => onTap(i),
        borderRadius: BorderRadius.circular(18),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
          height: 48,
          padding: EdgeInsets.symmetric(horizontal: active ? 16 : 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            gradient: active ? AppColors.accentGradient : null,
            boxShadow: active
                ? [
                    BoxShadow(
                      color: AppColors.primary.withValues(alpha: 0.38),
                      blurRadius: 16,
                      offset: const Offset(0, 6),
                    ),
                  ]
                : null,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              icon,
              if (active) ...[
                const SizedBox(width: 8),
                Text(
                  item.label,
                  style: const TextStyle(
                    color: AppColors.onAccent,
                    fontWeight: FontWeight.w800,
                    fontSize: 13,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Screen wrapper for pushed routes: ambient background + transparent
/// scaffold, so dialogs-style glass cards read the same everywhere.
class GlassScaffold extends StatelessWidget {
  final PreferredSizeWidget? appBar;
  final Widget body;
  final Widget? floatingActionButton;
  final Widget? bottomNavigationBar;

  const GlassScaffold({
    super.key,
    this.appBar,
    required this.body,
    this.floatingActionButton,
    this.bottomNavigationBar,
  });

  @override
  Widget build(BuildContext context) {
    return AmbientBackground(
      child: Scaffold(
        backgroundColor: Colors.transparent,
        appBar: appBar,
        body: body,
        floatingActionButton: floatingActionButton,
        bottomNavigationBar: bottomNavigationBar,
      ),
    );
  }
}
