import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/blocs/home/home_bloc.dart';
import 'package:office_tracker/blocs/home/home_event.dart';
import 'package:office_tracker/blocs/home/home_state.dart';
import 'package:office_tracker/models/attendance.dart';
import 'package:office_tracker/repositories/attendance_repository.dart';
import 'package:office_tracker/services/api_client.dart';
import 'package:office_tracker/services/offline_queue.dart';
import 'package:shared_preferences/shared_preferences.dart';

class FakeApiClient extends ApiClient {
  final HomeSummary stubbedSummary;
  FakeApiClient(this.stubbedSummary);

  @override
  Future<HomeSummary> fetchHomeSummary() async => stubbedSummary;

  @override
  Future<Map<String, dynamic>> fetchHomeSummaryRaw() async => {
        'today': {
          'date': '2026-09-08',
          'status': 'IN_OFFICE',
          'totalMinutes': 240,
          'onBreak': false,
        },
        'employee': {'id': 'emp_1', 'name': 'Fatima Noor'},
        'history': [],
        'corrections': [],
        'unreadNotificationsCount': 2,
        'serverTimeMs': 1788780000000,
      };
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('HomeSummary Model', () {
    test('parses atomic home summary payload correctly', () {
      final json = {
        'today': {
          'date': '2026-09-08',
          'status': 'IN_OFFICE',
          'statusLabel': 'Active in Office',
          'totalMinutes': 310,
          'timeWorkedFormatted': '5h 10m',
          'onBreak': true,
          'activeBreakStartedAtMs': 1788780000000,
          'breakDueBack': '13:30',
          'permittedBreakMinutes': 30,
          'breakMinutesTaken': 0,
        },
        'employee': {'id': 'emp_123', 'name': 'Ayesha Khan'},
        'history': [
          {
            'date': '2026-09-07',
            'status': 'IN_OFFICE',
            'totalMinutes': 450,
            'timeWorkedFormatted': '7h 30m',
          }
        ],
        'corrections': [
          {
            'id': 'corr_1',
            'date': '2026-09-05',
            'reason': 'Network glitch',
            'status': 'PENDING_HR',
          }
        ],
        'unreadNotificationsCount': 3,
        'serverTimeMs': 1788780000000,
      };

      final summary = HomeSummary.fromJson(json);

      expect(summary.todayDetails.employeeName, 'Ayesha Khan');
      expect(summary.todayDetails.attendance.status, PresenceStatus.inOffice);
      expect(summary.todayDetails.breakInfo.onBreak, isTrue);
      expect(summary.todayDetails.breakInfo.dueBackDisplay, '13:30');
      expect(summary.history.length, 1);
      expect(summary.history.first.date, '2026-09-07');
      expect(summary.corrections.length, 1);
      expect(summary.corrections.first.id, 'corr_1');
      expect(summary.unreadNotificationsCount, 3);
      expect(summary.serverTimeMs, 1788780000000);
    });
  });

  group('HomeBloc & AttendanceRepository', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
    });

    test('HomeBloc loads initial state and emits HomeLoaded', () async {
      final dummySummary = HomeSummary.fromJson({
        'today': {
          'date': '2026-09-08',
          'status': 'IN_OFFICE',
          'totalMinutes': 120,
        },
        'employee': {'id': 'emp_1', 'name': 'Fatima Noor'},
        'history': [],
        'corrections': [],
        'unreadNotificationsCount': 1,
        'serverTimeMs': 1788780000000,
      });

      final fakeApi = FakeApiClient(dummySummary);
      final repo = AttendanceRepository(apiClient: fakeApi, offlineQueue: OfflineQueue());
      final bloc = HomeBloc(repository: repo);

      expect(bloc.state, isA<HomeInitial>());

      bloc.add(const HomeStarted());

      await expectLater(
        bloc.stream,
        emitsInOrder([
          isA<HomeLoading>(),
          isA<HomeLoaded>().having((s) => s.summary.unreadNotificationsCount, 'unreadCount', 2),
        ]),
      );

      await bloc.close();
    });
  });
}
