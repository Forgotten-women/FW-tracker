import 'package:equatable/equatable.dart';

import '../../models/attendance.dart';

abstract class HomeState extends Equatable {
  const HomeState();

  @override
  List<Object?> get props => [];
}

class HomeInitial extends HomeState {
  const HomeInitial();
}

class HomeLoading extends HomeState {
  const HomeLoading();
}

class HomeLoaded extends HomeState {
  final HomeSummary summary;
  final bool isRefreshing;
  final bool isOffline;
  final bool isSubmittingAction;
  final String? errorMessage;
  final String? actionMessage;
  final DateTime liveNow;

  const HomeLoaded({
    required this.summary,
    this.isRefreshing = false,
    this.isOffline = false,
    this.isSubmittingAction = false,
    this.errorMessage,
    this.actionMessage,
    required this.liveNow,
  });

  HomeLoaded copyWith({
    HomeSummary? summary,
    bool? isRefreshing,
    bool? isOffline,
    bool? isSubmittingAction,
    String? errorMessage,
    String? actionMessage,
    DateTime? liveNow,
    bool clearMessages = false,
  }) {
    return HomeLoaded(
      summary: summary ?? this.summary,
      isRefreshing: isRefreshing ?? this.isRefreshing,
      isOffline: isOffline ?? this.isOffline,
      isSubmittingAction: isSubmittingAction ?? this.isSubmittingAction,
      errorMessage: clearMessages ? null : (errorMessage ?? this.errorMessage),
      actionMessage: clearMessages ? null : (actionMessage ?? this.actionMessage),
      liveNow: liveNow ?? this.liveNow,
    );
  }

  @override
  List<Object?> get props => [
        summary,
        isRefreshing,
        isOffline,
        isSubmittingAction,
        errorMessage,
        actionMessage,
        liveNow.second,
      ];
}

class HomeFailure extends HomeState {
  final String message;
  const HomeFailure(this.message);

  @override
  List<Object?> get props => [message];
}
