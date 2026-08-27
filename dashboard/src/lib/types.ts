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
  /** Human label for the signal currently carrying this presence. */
  presenceSource: string | null;
  presenceSourceKey: 'APP' | 'SENSOR' | 'NETWORK' | 'MANUAL' | 'UNKNOWN' | null;
  /**
   * True when presence no longer depends on the app being open, because the
   * office sensor recognises this phone. False means closing the app will stop
   * the clock.
   */
  sensorCarried: boolean;
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
    /** Unrecognised devices seen at least `unknownDeviceMinSightings` times. */
    unknownDevicesSeen24h: number;
    /** Seen once or twice only - stray frames, not devices actually present. */
    unknownDevicesTransient24h: number;
    unknownDeviceMinSightings: number;
    averageTimeWorkedToday: string;
    liveDashboardClients: number;
  };
  officeConfig: {
    officeName: string;
    networks: string[];
    workHours: string;
    activeThreshold: string;
    gracePeriod: string;
    /**
     * 'enforced' | 'listed-not-enforced' | 'not-configured'.
     * The middle state matters: BSSIDs collected but not yet switched on is a
     * deliberate step, not an outstanding task.
     */
    bssidVerification: 'enforced' | 'listed-not-enforced' | 'not-configured';
    bssidListed: number;
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
