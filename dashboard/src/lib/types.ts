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
  onBreak?: boolean;
  activeBreakMinutes?: number;
  breakMinutes?: number;
  excessBreakMinutes?: number;
  dailyDeficitMinutes?: number;
  lateMinutes?: number;
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
  baseSalary?: number | null;
  currency?: string | null;
  dailyRate?: number | null;
  startDate?: string | null;
}

export interface EnrollmentCode {
  code: string;
  employee: { id: string; name: string };
  expiresAtDisplay: string;
}

export type AlertType =
  | 'CONTRACT_EXPIRY'
  | 'PROBATION_REVIEW'
  | 'DOCUMENT_EXPIRY'
  | 'PERFORMANCE_REVIEW';

export type AlertSeverity = 'overdue' | 'urgent' | 'warning';

export interface HrAlert {
  type: AlertType;
  key: string;
  /** The date the alert is about; a dismissal only holds while this is unchanged. */
  value: string;
  employeeId: string;
  employeeName: string;
  date: string;
  daysUntil: number;
  severity: AlertSeverity;
  title: string;
  detail: string;
  overdue: boolean;
}

export interface HrAlerts {
  summary: {
    total: number;
    overdue: number;
    contractExpiry: number;
    probationReview: number;
    documentExpiry: number;
    performanceReview: number;
  };
  alerts: HrAlert[];
}

export interface AttendanceCorrection {
  id: string;
  employeeId: string;
  employeeName: string;
  role: string;
  date: string;
  reason: string;
  requestedChange: {
    adjustmentMinutes?: number;
    [key: string]: unknown;
  };
  appliedChange: {
    adjustmentMinutes?: number;
    [key: string]: unknown;
  };
  requestedAt: string;
  reviewedAt?: string | null;
  reviewNotes?: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'AMENDED' | 'INFO_REQUESTED';
}

export interface WarningTrigger {
  id: string;
  employeeId: string;
  employeeName: string;
  reason: string;
  occurrences: number;
  period: string;
  raisedAt: string;
  raisedOn: string;
  status: 'PENDING_REVIEW' | 'CONFIRMED' | 'WAIVED' | 'CORRECTED' | 'SUPERSEDED';
  proposedLevel: string | null;
  proposedLevelLabel: string | null;
  sequenceExhausted: boolean;
  priorWarnings: number;
}

export interface FormalWarningItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeRole?: string;
  level: string;
  levelLabel: string;
  warningType: string;
  explanation: string;
  issuedAt: string;
  issuedAtMs: number;
  issuedDate: string;
  expiryDate: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'WITHDRAWN';
  acknowledgedAt: string | null;
  ackComments: string | null;
  outcome: string | null;
}

export interface WarningBoardEmployee {
  employeeId: string;
  employeeName: string;
  role: string;
  band: 'GREEN' | 'AMBER' | 'RED' | 'UNKNOWN';
  bandLabel: string;
  lateOccurrences: number | null;
  allowed: number | null;
  pendingReview: boolean;
  activeWarnings: number;
  highestLevel: string | null;
  nextLevelIfConfirmed: string | null;
  sequenceExhausted: boolean;
}

export interface WarningBoardSummary {
  counts: {
    red: number;
    amber: number;
    green: number;
    unknown: number;
  };
  employees: WarningBoardEmployee[];
}

export interface AbsenceRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  role?: string;
  date: string;
  absenceType: string;
  reason: string | null;
  evidenceDocumentId: string | null;
  documentTitle: string | null;
  detectedAt: string;
  status: 'PENDING_REVIEW' | 'CONFIRMED' | 'DISMISSED';
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  deductAnnualLeave: boolean;
  treatAsUnpaid: boolean;
  createWarningTrigger: boolean;
  consequencesAppliedAt: string | null;
}

export interface LeaveBalanceDetails {
  blocked: boolean;
  reason?: string;
  message?: string;
  holidayYear?: {
    from: string;
    to: string;
    monthsCompleted: number;
  };
  nextAccrualDate?: string;
  annualEntitlement: number;
  accrued: number;
  taken: number;
  booked: number;
  available: number;
  isNegative: boolean;
}

export interface LeaveRequestItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeRole?: string;
  type: string;
  leaveTypeId: string;
  from: string;
  to: string;
  days: number;
  status: 'PENDING_HR' | 'PENDING_MANAGER' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reason?: string;
  notes?: string | null;
  shortfallDays?: number;
  exceedsBalance?: boolean;
  reducesEntitlement?: boolean;
  requiresEvidence?: boolean;
  submittedAt: string;
  submittedAtMs?: number;
  decidedAt?: string | null;
  decidedBy?: string | null;
  balance?: LeaveBalanceDetails | null;
  blocked?: string | null;
}

export interface EmployeeLeaveOverview {
  employeeId: string;
  employeeName: string;
  role: string;
  balance: LeaveBalanceDetails;
}

export interface TeamCalendarLeave {
  id: string;
  employeeId: string;
  employeeName: string;
  type: string;
  from: string;
  to: string;
  days: number;
}

export interface LeaveTypeItem {
  id: string;
  name: string;
  reducesEntitlement: boolean;
  requiresEvidence: boolean;
  isPaid: boolean;
}

export interface DocumentTypeOption {
  id: string;
  name: string;
  confidentiality: 'normal' | 'sensitive' | 'highly_confidential';
  requires_expiry: number;
  requires_acknowledgement: number;
}

export interface EmployeeDocumentItem {
  id: string;
  type: string;
  typeId: string;
  title: string;
  version: number;
  filename: string | null;
  sizeBytes: number;
  mimeType: string | null;
  storageProvider: string;
  confidentiality: 'normal' | 'sensitive' | 'highly_confidential';
  verificationStatus: 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED';
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  rejectionReason?: string | null;
  effectiveDate?: string | null;
  expiryDate?: string | null;
  uploadedAt: string;
  acknowledgementRequired?: boolean;
  acknowledgedAt?: string | null;
}

export interface PendingVerificationDoc {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeRole?: string;
  documentTypeId: string;
  documentTypeName: string;
  title: string;
  version: number;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  storageProvider: string;
  effectiveDate?: string | null;
  expiryDate?: string | null;
  uploadedAt: string;
}

export interface KycRequirementItem {
  typeId: string;
  name: string;
  description: string;
  isMandatory: boolean;
  status: 'VERIFIED' | 'PENDING_VERIFICATION' | 'REJECTED' | 'MISSING';
  documentId?: string | null;
  filename?: string | null;
  rejectionReason?: string | null;
  expiryDate?: string | null;
  uploadedAt?: string | null;
}

export interface KycChecklistResponse {
  employeeId: string;
  employeeName: string;
  employeeRole: string;
  overallKycStatus: 'COMPLETE' | 'PENDING_REVIEW' | 'INCOMPLETE';
  completionPercentage: number;
  summary: {
    totalMandatory: number;
    verifiedCount: number;
    pendingCount: number;
    rejectedCount: number;
    missingCount: number;
  };
  mandatoryChecklist: KycRequirementItem[];
  optionalChecklist: KycRequirementItem[];
}

export interface NotificationItem {
  id: string;
  employeeId?: string | null;
  userId?: string | null;
  category: 'LEAVE' | 'CORRECTION' | 'ABSENCE' | 'DOCUMENT' | 'WARNING' | 'HR_ALERT' | 'ATTENDANCE' | string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'urgent';
  link?: string | null;
  at: string;
  date: string;
  createdAt: number;
  read: boolean;
  dismissed: boolean;
}

export interface NotificationsResponse {
  status: string;
  unreadCount: number;
  notifications: NotificationItem[];
}

// ---------------------------------------------------------------------------
// Payroll (2.13)
// ---------------------------------------------------------------------------

export interface SalaryRecord {
  blocked: false;
  salaryId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  currency: string;
  payFrequency: string;
  monthly: number;
  annual: number;
  weekly: number;
  daily: number;
  dailyPrecise: number;
  formula: string;
  workingDaysPerYear: number;
}

export interface SalaryBlocked {
  blocked: true;
  reason: string;
  message: string;
}

export interface PayrollPeriod {
  id: string;
  name: string;
  from: string;
  to: string;
  exchangeRate?: number;
  status: 'OPEN' | 'DRAFT' | 'CLOSED';
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface PayrollEmployee {
  employeeId: string;
  employeeName: string;
  role?: string;
  salary: SalaryRecord | SalaryBlocked;
  workingDays: number;
  grossPay: number | null;
  adjustmentsTotal: number;
  netPay: number | null;
  blocked: boolean;
  blockedReason?: string;
}

export interface PayrollBlocked {
  employeeId: string;
  employeeName: string;
  role?: string;
  blockedReason: string;
}

export interface PayrollPrepareSheet {
  periodId: string;
  periodName: string;
  from: string;
  to: string;
  status: string;
  employees: PayrollEmployee[];
  blocked: PayrollBlocked[];
  totals: {
    employeeCount: number;
    blockedCount: number;
    grossTotal: number;
    adjustmentsTotal: number;
    netTotal: number;
  };
}

export interface PayrollAdjustment {
  id: string;
  employeeId: string;
  employeeName: string;
  type: string;
  calculated: { days: number | null; amount: number | null };
  approved: { days: number | null; amount: number | null } | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  explanation: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface StarterCalculation {
  applicable: boolean;
  blocked?: boolean;
  reason?: string;
  startDate?: string;
  eligibleWorkingDays?: number;
  fullPeriodWorkingDays?: number;
  dailyRate?: number;
  calculatedGross?: number;
  calculatedGrossRoundedDaily?: number;
  fullMonthlySalary?: number;
  formula?: string;
}

export interface LeaverCalculation {
  blocked?: boolean;
  reason?: string;
  message?: string;
  lastWorkingDate?: string;
  workedDays?: number;
  grossPay?: number;
  formula?: string;
  leave?: {
    blocked: boolean;
    untakenDays: number | null;
    excessTakenDays: number | null;
    untakenValue: number | null;
    excessDeduction: number | null;
  };
  estimatedFinalPay?: number | null;
}
