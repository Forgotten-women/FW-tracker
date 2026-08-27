// Wire types for the backend API.
//
// The previous dashboard indexed untyped JSON, so a server-side rename broke it
// silently at runtime.

export type PresenceStatus =
  | 'IN_OFFICE'
  | 'GRACE_PERIOD'
  | 'AWAY'
  | 'NOT_CHECKED_IN'
  | 'CLOSED';

export interface WorkSession {
  from: string;
  to: string;
  duration: string;
  open: boolean;
}

export interface EmployeeDay {
  employeeId: string;
  employeeName: string;
  role: string;
  date: string;
  status: PresenceStatus;
  statusLabel: string;
  firstCheckIn: string;
  lastActiveTime: string;
  totalMinutes: number;
  timeWorkedFormatted: string;
  inactivityMinutes: number;
  graceMinutesLeft: number;
  adjustmentMinutes: number;
  /** A session hit the duration cap - usually a phone left in the office. */
  needsReview: boolean;
  sessions: WorkSession[];
}

export interface Movement {
  id: number;
  time: string;
  type: string;
  name: string;
  details: string;
}

export interface DashboardSummary {
  status: string;
  timezone: string;
  currentTime: string;
  currentDate: string;
  currentDateKey: string;
  stats: {
    totalActiveEmployees: number;
    currentlyInOffice: number;
    currentlyInGracePeriod: number;
    currentlyAway: number;
    totalAttendeesToday: number;
    unknownDevicesSeen24h: number;
    averageTimeWorkedToday: string;
    liveDashboardClients: number;
  };
  officeConfig: {
    officeName: string;
    networks: string[];
    workHours: string;
    activeThreshold: string;
    gracePeriod: string;
    /** 'enforced' or 'NOT CONFIGURED' - surfaced in the UI, not just logged. */
    bssidVerification: string;
  };
  inOffice: EmployeeDay[];
  grace: EmployeeDay[];
  away: EmployeeDay[];
  notArrived: EmployeeDay[];
  todayAttendance: EmployeeDay[];
  needsReview: EmployeeDay[];
  recentMovements: Movement[];
}

export interface AdminEmployee {
  id: string;
  name: string;
  role: string;
  active: boolean;
  deviceCount: number;
  createdAt: string;
}

export interface EnrollmentCode {
  code: string;
  employee: { id: string; name: string };
  expiresAtDisplay: string;
}
