import 'package:equatable/equatable.dart';

abstract class HomeEvent extends Equatable {
  const HomeEvent();

  @override
  List<Object?> get props => [];
}

class HomeStarted extends HomeEvent {
  const HomeStarted();
}

class HomeRefreshRequested extends HomeEvent {
  const HomeRefreshRequested();
}

class HomeTimerTicked extends HomeEvent {
  final DateTime now;
  const HomeTimerTicked(this.now);

  @override
  List<Object?> get props => [now];
}

class HomeBreakToggleRequested extends HomeEvent {
  const HomeBreakToggleRequested();
}

class HomeClockOutRequested extends HomeEvent {
  const HomeClockOutRequested();
}
