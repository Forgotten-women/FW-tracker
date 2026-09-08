import 'package:flutter/material.dart';
import '../../theme.dart';

/// Shimmer skeleton loader shown on the very first launch before any cache exists.
class HomeSkeletonLoader extends StatefulWidget {
  const HomeSkeletonLoader({super.key});

  @override
  State<HomeSkeletonLoader> createState() => _HomeSkeletonLoaderState();
}

class _HomeSkeletonLoaderState extends State<HomeSkeletonLoader>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat(reverse: true);
    _animation = Tween<double>(begin: 0.25, end: 0.65).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Widget _shimmerBox({
    required double width,
    required double height,
    double borderRadius = 8,
  }) {
    return AnimatedBuilder(
      animation: _animation,
      builder: (context, child) {
        return Container(
          width: width,
          height: height,
          decoration: BoxDecoration(
            color: AppColors.border.withValues(alpha: _animation.value),
            borderRadius: BorderRadius.circular(borderRadius),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 30),
      children: [
        // Hero Card Skeleton
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: AppColors.surfaceDark,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _shimmerBox(width: 110, height: 26, borderRadius: 14),
                  _shimmerBox(width: 80, height: 20, borderRadius: 6),
                ],
              ),
              const SizedBox(height: 22),
              _shimmerBox(width: 160, height: 40, borderRadius: 8),
              const SizedBox(height: 8),
              _shimmerBox(width: 210, height: 14, borderRadius: 4),
              const SizedBox(height: 20),
              _shimmerBox(width: double.infinity, height: 8, borderRadius: 4),
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(child: _shimmerBox(width: double.infinity, height: 48, borderRadius: 12)),
                  const SizedBox(width: 12),
                  Expanded(child: _shimmerBox(width: double.infinity, height: 48, borderRadius: 12)),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        // Metrics Grid Skeleton
        Row(
          children: [
            Expanded(child: _shimmerBox(width: double.infinity, height: 90, borderRadius: 16)),
            const SizedBox(width: 12),
            Expanded(child: _shimmerBox(width: double.infinity, height: 90, borderRadius: 16)),
          ],
        ),
        const SizedBox(height: 16),

        // Action Buttons Skeleton
        Row(
          children: [
            Expanded(child: _shimmerBox(width: double.infinity, height: 50, borderRadius: 14)),
            const SizedBox(width: 12),
            Expanded(child: _shimmerBox(width: double.infinity, height: 50, borderRadius: 14)),
          ],
        ),
        const SizedBox(height: 24),

        // History Timeline Skeleton
        _shimmerBox(width: 180, height: 16, borderRadius: 4),
        const SizedBox(height: 12),
        _shimmerBox(width: double.infinity, height: 68, borderRadius: 14),
        const SizedBox(height: 10),
        _shimmerBox(width: double.infinity, height: 68, borderRadius: 14),
        const SizedBox(height: 10),
        _shimmerBox(width: double.infinity, height: 68, borderRadius: 14),
      ],
    );
  }
}
