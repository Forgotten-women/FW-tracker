import 'dart:async';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../repositories/attendance_repository.dart';
import 'home_event.dart';
import 'home_state.dart';

class HomeBloc extends Bloc<HomeEvent, HomeState> {
  final AttendanceRepository repository;
  Timer? _ticker;

  HomeBloc({required this.repository}) : super(const HomeInitial()) {
    on<HomeStarted>(_onStarted);
    on<HomeRefreshRequested>(_onRefreshRequested);
    on<HomeTimerTicked>(_onTimerTicked);
    on<HomeBreakToggleRequested>(_onBreakToggleRequested);
    on<HomeClockOutRequested>(_onClockOutRequested);

    _startTicker();
  }

  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
      add(HomeTimerTicked(DateTime.now()));
    });
  }

  Future<void> _onStarted(HomeStarted event, Emitter<HomeState> emit) async {
    // 1. Instant Cache Render (stale-while-revalidate)
    final cached = await repository.getCachedHomeSummary();
    if (cached != null) {
      emit(HomeLoaded(
        summary: cached,
        isRefreshing: true,
        isOffline: false,
        liveNow: DateTime.now(),
      ));
    } else {
      emit(const HomeLoading());
    }

    // 2. Network revalidation
    try {
      final fresh = await repository.fetchFreshHomeSummary();
      emit(HomeLoaded(
        summary: fresh,
        isRefreshing: false,
        isOffline: false,
        liveNow: DateTime.now(),
      ));
    } catch (e) {
      if (state is HomeLoaded) {
        emit((state as HomeLoaded).copyWith(
          isRefreshing: false,
          isOffline: true,
        ));
      } else {
        emit(HomeFailure(e.toString()));
      }
    }
  }

  Future<void> _onRefreshRequested(
      HomeRefreshRequested event, Emitter<HomeState> emit) async {
    if (state is HomeLoaded) {
      emit((state as HomeLoaded).copyWith(
        isRefreshing: true,
        clearMessages: true,
      ));
    }

    try {
      final fresh = await repository.fetchFreshHomeSummary();
      emit(HomeLoaded(
        summary: fresh,
        isRefreshing: false,
        isOffline: false,
        liveNow: DateTime.now(),
      ));
    } catch (e) {
      if (state is HomeLoaded) {
        emit((state as HomeLoaded).copyWith(
          isRefreshing: false,
          isOffline: true,
          errorMessage: 'Unable to refresh: offline or server unavailable',
        ));
      } else {
        emit(HomeFailure(e.toString()));
      }
    }
  }

  void _onTimerTicked(HomeTimerTicked event, Emitter<HomeState> emit) {
    if (state is HomeLoaded) {
      emit((state as HomeLoaded).copyWith(liveNow: event.now));
    }
  }

  Future<void> _onBreakToggleRequested(
      HomeBreakToggleRequested event, Emitter<HomeState> emit) async {
    if (state is! HomeLoaded) return;
    final current = state as HomeLoaded;
    emit(current.copyWith(isSubmittingAction: true, clearMessages: true));

    try {
      String msg;
      if (current.summary.todayDetails.breakInfo.onBreak) {
        final res = await repository.endBreak();
        msg = res.message.isNotEmpty
            ? res.message
            : 'Break ended (${res.actualMinutes}m taken)';
      } else {
        final res = await repository.startBreak();
        msg = 'Break started. Due back at ${res.dueBackAt}';
      }

      // Re-fetch latest summary to sync server-calculated values
      final fresh = await repository.fetchFreshHomeSummary();
      emit(HomeLoaded(
        summary: fresh,
        isSubmittingAction: false,
        actionMessage: msg,
        liveNow: DateTime.now(),
      ));
    } catch (e) {
      emit(current.copyWith(
        isSubmittingAction: false,
        errorMessage: e.toString(),
      ));
    }
  }

  Future<void> _onClockOutRequested(
      HomeClockOutRequested event, Emitter<HomeState> emit) async {
    if (state is! HomeLoaded) return;
    final current = state as HomeLoaded;
    emit(current.copyWith(isSubmittingAction: true, clearMessages: true));

    try {
      await repository.clockOut();
      final fresh = await repository.fetchFreshHomeSummary();
      emit(HomeLoaded(
        summary: fresh,
        isSubmittingAction: false,
        actionMessage: 'Clocked out for today',
        liveNow: DateTime.now(),
      ));
    } catch (e) {
      emit(current.copyWith(
        isSubmittingAction: false,
        errorMessage: e.toString(),
      ));
    }
  }

  @override
  Future<void> close() {
    _ticker?.cancel();
    return super.close();
  }
}
