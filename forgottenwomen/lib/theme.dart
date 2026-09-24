import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Accent colours the user can pick in Settings → Appearance.
enum AccentChoice { indigo, teal, rose, amber, sky }

/// One complete set of colours for a brightness + accent combination.
///
/// Field names are semantic (bg, card, textPrimary…). The legacy names on
/// [AppColors] (bgDark, surfaceDark, textLight…) predate light mode and are
/// kept as aliases so the existing ~770 call sites switch palettes without
/// being rewritten.
class AppPalette {
  final Brightness brightness;

  final Color bg; // opaque page canvas
  final Color card; // translucent glass fill for in-flow cards
  final Color cardRaised; // stronger translucent fill for chips inside cards
  final Color sheet; // opaque surface for dialogs, sheets, menus
  final Color border; // hairlines, dividers, progress tracks

  final Color textPrimary;
  final Color textSecondary;
  final Color textTertiary;

  final Color primary; // accent fill (buttons, rings)
  final Color primaryLight; // accent used as text/icon colour on surfaces
  final Color accentEnd; // second stop of accent gradients

  final Color teal;
  final Color tealDark;
  final Color amber;
  final Color danger;
  final Color neutral;

  final Color glassFill;
  final Color glassFillStrong;
  final Color glassBorder;
  final Color shadow;
  final List<Color> orbs;

  const AppPalette({
    required this.brightness,
    required this.bg,
    required this.card,
    required this.cardRaised,
    required this.sheet,
    required this.border,
    required this.textPrimary,
    required this.textSecondary,
    required this.textTertiary,
    required this.primary,
    required this.primaryLight,
    required this.accentEnd,
    required this.teal,
    required this.tealDark,
    required this.amber,
    required this.danger,
    required this.neutral,
    required this.glassFill,
    required this.glassFillStrong,
    required this.glassBorder,
    required this.shadow,
    required this.orbs,
  });

  bool get isDark => brightness == Brightness.dark;

  static AppPalette build(Brightness brightness, AccentChoice accent) {
    final dark = brightness == Brightness.dark;
    final a = _accent(accent, dark);
    if (dark) {
      return AppPalette(
        brightness: brightness,
        bg: const Color(0xFF080B16),
        card: const Color(0x14FFFFFF),
        cardRaised: const Color(0x1CFFFFFF),
        sheet: const Color(0xFF131829),
        border: const Color(0x1FFFFFFF),
        textPrimary: const Color(0xFFF4F5FB),
        textSecondary: const Color(0xFFA3A8C3),
        textTertiary: const Color(0xFF6F7592),
        primary: a[0],
        primaryLight: a[1],
        accentEnd: a[2],
        teal: const Color(0xFF10B981),
        tealDark: const Color(0xFF34D399),
        amber: const Color(0xFFF59E0B),
        danger: const Color(0xFFF43F5E),
        neutral: const Color(0xFF7C8299),
        glassFill: const Color(0x12FFFFFF),
        glassFillStrong: const Color(0x1AFFFFFF),
        glassBorder: const Color(0x24FFFFFF),
        shadow: const Color(0x66000000),
        orbs: [
          a[0].withValues(alpha: 0.45),
          const Color(0xFFA855F7).withValues(alpha: 0.30),
          const Color(0xFF14B8A6).withValues(alpha: 0.26),
        ],
      );
    }
    return AppPalette(
      brightness: brightness,
      bg: const Color(0xFFEEF0FA),
      card: const Color(0x9EFFFFFF),
      cardRaised: const Color(0xC7FFFFFF),
      sheet: const Color(0xFFFAFAFE),
      border: const Color(0x1A141729),
      textPrimary: const Color(0xFF141729),
      textSecondary: const Color(0xFF5B6078),
      textTertiary: const Color(0xFF8C91A8),
      primary: a[0],
      primaryLight: a[1],
      accentEnd: a[2],
      teal: const Color(0xFF059669),
      tealDark: const Color(0xFF047857),
      amber: const Color(0xFFD97706),
      danger: const Color(0xFFE11D48),
      neutral: const Color(0xFF64748B),
      glassFill: const Color(0x8CFFFFFF),
      glassFillStrong: const Color(0xB8FFFFFF),
      glassBorder: const Color(0xD9FFFFFF),
      shadow: const Color(0x1F312E81),
      orbs: [
        a[0].withValues(alpha: 0.42),
        const Color(0xFFEC4899).withValues(alpha: 0.30),
        const Color(0xFF14B8A6).withValues(alpha: 0.30),
      ],
    );
  }

  /// [fill, text-safe accent, gradient end] per accent and brightness.
  static List<Color> _accent(AccentChoice accent, bool dark) {
    switch (accent) {
      case AccentChoice.indigo:
        return dark
            ? const [Color(0xFF6366F1), Color(0xFFA5B4FC), Color(0xFF8B5CF6)]
            : const [Color(0xFF4F46E5), Color(0xFF4338CA), Color(0xFF8B5CF6)];
      case AccentChoice.teal:
        return dark
            ? const [Color(0xFF14B8A6), Color(0xFF5EEAD4), Color(0xFF06B6D4)]
            : const [Color(0xFF0D9488), Color(0xFF0F766E), Color(0xFF06B6D4)];
      case AccentChoice.rose:
        return dark
            ? const [Color(0xFFF43F5E), Color(0xFFFDA4AF), Color(0xFFEC4899)]
            : const [Color(0xFFE11D48), Color(0xFFBE123C), Color(0xFFEC4899)];
      case AccentChoice.amber:
        return dark
            ? const [Color(0xFFF59E0B), Color(0xFFFCD34D), Color(0xFFF97316)]
            : const [Color(0xFFD97706), Color(0xFFB45309), Color(0xFFF97316)];
      case AccentChoice.sky:
        return dark
            ? const [Color(0xFF0EA5E9), Color(0xFF7DD3FC), Color(0xFF6366F1)]
            : const [Color(0xFF0284C7), Color(0xFF0369A1), Color(0xFF6366F1)];
    }
  }
}

/// Colours for the current theme. Every getter reads the active [AppPalette],
/// so switching light/dark or accent is a single assignment plus a rebuild
/// (see [ThemeController]).
class AppColors {
  AppColors._();

  static AppPalette palette =
      AppPalette.build(Brightness.dark, AccentChoice.indigo);

  static bool get isDark => palette.isDark;

  // Semantic names — prefer these in new code.
  static Color get bg => palette.bg;
  static Color get card => palette.card;
  static Color get cardRaised => palette.cardRaised;
  static Color get sheet => palette.sheet;
  static Color get textPrimary => palette.textPrimary;
  static Color get textSecondary => palette.textSecondary;
  static Color get textTertiary => palette.textTertiary;
  static Color get accentEnd => palette.accentEnd;
  static Color get neutral => palette.neutral;
  static Color get glassFill => palette.glassFill;
  static Color get glassFillStrong => palette.glassFillStrong;
  static Color get glassBorder => palette.glassBorder;
  static Color get shadow => palette.shadow;
  static List<Color> get orbs => palette.orbs;

  /// Text/icon colour on a solid accent, teal or danger fill.
  static const Color onAccent = Colors.white;

  /// A wash of the foreground colour: white on dark, ink on light.
  static Color overlay(double alpha) =>
      palette.textPrimary.withValues(alpha: alpha);

  static LinearGradient get accentGradient => LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [palette.primary, palette.accentEnd],
      );

  // Shared across both themes.
  static Color get primary => palette.primary;
  static Color get primaryLight => palette.primaryLight;
  static Color get teal => palette.teal;
  static Color get tealDark => palette.tealDark;
  static Color get amber => palette.amber;
  static Color get danger => palette.danger;
  static Color get border => palette.border;

  // Legacy aliases (dark-only era names).
  static Color get bgDark => palette.bg;
  static Color get surface => palette.card;
  static Color get surfaceDark => palette.card;
  static Color get surfaceLight => palette.cardRaised;
  static Color get slate => palette.neutral;
  static Color get slateDark => palette.cardRaised;
  static Color get textLight => palette.textPrimary;
  static Color get textMuted => palette.textSecondary;
}

/// Numeric display face for timers, durations and counters.
TextStyle monoStyle({
  double fontSize = 14,
  FontWeight fontWeight = FontWeight.w700,
  Color? color,
  double? letterSpacing,
}) =>
    GoogleFonts.jetBrainsMono(
      fontSize: fontSize,
      fontWeight: fontWeight,
      color: color ?? AppColors.textPrimary,
      letterSpacing: letterSpacing,
    );

/// Holds the user's theme mode + accent, persists them, and pushes the
/// resolved palette into [AppColors].
class ThemeController extends ChangeNotifier with WidgetsBindingObserver {
  ThemeController._();
  static final ThemeController instance = ThemeController._();

  static const _modeKey = 'theme_mode';
  static const _accentKey = 'theme_accent';

  ThemeMode _mode = ThemeMode.system;
  AccentChoice _accent = AccentChoice.indigo;

  ThemeMode get mode => _mode;
  AccentChoice get accent => _accent;

  Brightness get effectiveBrightness {
    switch (_mode) {
      case ThemeMode.light:
        return Brightness.light;
      case ThemeMode.dark:
        return Brightness.dark;
      case ThemeMode.system:
        return WidgetsBinding.instance.platformDispatcher.platformBrightness;
    }
  }

  Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final m = prefs.getString(_modeKey);
      final a = prefs.getString(_accentKey);
      _mode = ThemeMode.values.firstWhere(
        (v) => v.name == m,
        orElse: () => ThemeMode.system,
      );
      _accent = AccentChoice.values.firstWhere(
        (v) => v.name == a,
        orElse: () => AccentChoice.indigo,
      );
    } catch (_) {}
    WidgetsBinding.instance.addObserver(this);
    _apply();
  }

  Future<void> setMode(ThemeMode mode) async {
    if (mode == _mode) return;
    _mode = mode;
    _apply();
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_modeKey, mode.name);
    } catch (_) {}
  }

  Future<void> setAccent(AccentChoice accent) async {
    if (accent == _accent) return;
    _accent = accent;
    _apply();
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_accentKey, accent.name);
    } catch (_) {}
  }

  @override
  void didChangePlatformBrightness() {
    if (_mode != ThemeMode.system) return;
    _apply();
    notifyListeners();
  }

  void _apply() {
    AppColors.palette = AppPalette.build(effectiveBrightness, _accent);
    SystemChrome.setSystemUIOverlayStyle(_overlayStyle());
  }

  SystemUiOverlayStyle _overlayStyle() {
    final dark = AppColors.isDark;
    return SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: dark ? Brightness.light : Brightness.dark,
      statusBarBrightness: dark ? Brightness.dark : Brightness.light,
      systemNavigationBarColor: AppColors.bg,
      systemNavigationBarIconBrightness:
          dark ? Brightness.light : Brightness.dark,
    );
  }

  SystemUiOverlayStyle get overlayStyle => _overlayStyle();
}

ThemeData buildTheme() {
  final p = AppColors.palette;
  final base = ThemeData(useMaterial3: true, brightness: p.brightness);
  final text = GoogleFonts.plusJakartaSansTextTheme(base.textTheme).apply(
    bodyColor: p.textPrimary,
    displayColor: p.textPrimary,
  );

  OutlineInputBorder field(Color c, [double w = 1]) => OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide(color: c, width: w),
      );

  return base.copyWith(
    scaffoldBackgroundColor: p.bg,
    primaryColor: p.primary,
    textTheme: text,
    colorScheme: ColorScheme(
      brightness: p.brightness,
      primary: p.primary,
      onPrimary: AppColors.onAccent,
      secondary: p.teal,
      onSecondary: AppColors.onAccent,
      error: p.danger,
      onError: AppColors.onAccent,
      surface: p.sheet,
      onSurface: p.textPrimary,
      onSurfaceVariant: p.textSecondary,
      outline: p.border,
      outlineVariant: p.border,
      surfaceTint: Colors.transparent,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      foregroundColor: p.textPrimary,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      systemOverlayStyle: ThemeController.instance.overlayStyle,
      titleTextStyle: GoogleFonts.plusJakartaSans(
        color: p.textPrimary,
        fontSize: 18,
        fontWeight: FontWeight.w800,
        letterSpacing: -0.3,
      ),
      iconTheme: IconThemeData(color: p.textPrimary),
    ),
    cardTheme: CardThemeData(
      color: p.card,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: BorderSide(color: p.glassBorder),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: p.sheet,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      titleTextStyle: GoogleFonts.plusJakartaSans(
        color: p.textPrimary,
        fontSize: 17,
        fontWeight: FontWeight.w800,
      ),
      contentTextStyle: GoogleFonts.plusJakartaSans(
        color: p.textSecondary,
        fontSize: 13,
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: p.sheet,
      surfaceTintColor: Colors.transparent,
      showDragHandle: false,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: p.sheet,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      contentTextStyle: GoogleFonts.plusJakartaSans(
        color: AppColors.onAccent,
        fontSize: 13,
        fontWeight: FontWeight.w600,
      ),
    ),
    dividerTheme: DividerThemeData(color: p.border, thickness: 1),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: p.primary,
      linearTrackColor: p.border,
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: Colors.transparent,
      indicatorColor: p.primary.withValues(alpha: 0.16),
      selectedIconTheme: IconThemeData(color: p.primaryLight),
      unselectedIconTheme: IconThemeData(color: p.textSecondary),
      selectedLabelTextStyle: TextStyle(
        color: p.primaryLight,
        fontWeight: FontWeight.w700,
        fontSize: 12,
      ),
      unselectedLabelTextStyle: TextStyle(color: p.textSecondary, fontSize: 12),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.isDark ? const Color(0x0FFFFFFF) : const Color(0xB3FFFFFF),
      hintStyle: TextStyle(color: p.textTertiary),
      labelStyle: TextStyle(color: p.textSecondary),
      border: field(p.border),
      enabledBorder: field(p.border),
      focusedBorder: field(p.primary, 1.6),
      errorBorder: field(p.danger),
      focusedErrorBorder: field(p.danger, 1.6),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: p.primary,
        foregroundColor: AppColors.onAccent,
        elevation: 0,
        textStyle: GoogleFonts.plusJakartaSans(
          fontWeight: FontWeight.w800,
          fontSize: 14,
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: p.primary,
        foregroundColor: AppColors.onAccent,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: p.textPrimary,
        side: BorderSide(color: p.border),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: p.primaryLight),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? Colors.white : p.textTertiary,
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? p.primary : p.border,
      ),
      trackOutlineColor: WidgetStateProperty.all(Colors.transparent),
    ),
    datePickerTheme: DatePickerThemeData(
      backgroundColor: p.sheet,
      surfaceTintColor: Colors.transparent,
      headerBackgroundColor: p.primary,
      headerForegroundColor: AppColors.onAccent,
    ),
  );
}
