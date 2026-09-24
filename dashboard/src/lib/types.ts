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
  employeeNumber?: string | null;
  role: string;
  date: string;
  status: PresenceStatus;
  statusLabel: string;
  workMode?: 'IN_OFFICE' | 'REMOTE' | 'HYBRID';
  remoteAllowed?: boolean;
  onBreak?: boolean;
  activeBreakMinutes?: number;
  breakMinutes?: number;
  excessBreakMinutes?: number;
  dailyDeficitMinutes?: number;
  lateMinutes?: number;
  isLate?: boolean;
  scheduledStartTime?: string;
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
  employeeNumber?: string | null;
  active: boolean;
  deviceCount: number;
  createdAt: string;
  baseSalary?: number | null;
  currency?: string | null;
  dailyRate?: number | null;
  startDate?: string | null;
  appTrackingEnabled?: boolean;
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
  employeeNumber?: string | null;
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
  employeeNumber?: string | null;
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
  employeeNumber?: string | null;
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
  employeeNumber?: string | null;
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
  employeeNumber?: string | null;
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
    anniversaryDate?: string;
    monthsCompleted: number;
  };
  cycleStartDate?: string;
  cycleEndDate?: string;
  nextRenewalDate?: string;
  nextAccrualDate?: string;
  officialJoiningDate?: string;
  annualEntitlement: number;
  annualEntitlementDays?: number;
  accrued: number;
  accruedDays?: number;
  taken: number;
  takenDays?: number;
  approvedCarryForward?: number;
  approvedCarryForwardDays?: number;
  remainingCurrentCycle?: number;
  remainingCurrentCycleDays?: number;
  dueToExpire?: number;
  leaveDueToExpire?: number;
  alreadyLapsed?: number;
  leaveAlreadyLapsed?: number;
  renewalDate?: string;
  booked: number;
  bookedDays?: number;
  available: number;
  availableDays?: number;
  isNegative: boolean;
  carryForwardDecision?: {
    approvedDays: number;
    lapsedDays: number;
    decision: string;
    approvedBy?: string;
    approvedAt?: number;
    notes?: string;
  } | null;
}

export interface LeaveRequestItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber?: string | null;
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
  isPaid?: boolean;
  defaultIsPaid?: boolean;
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
  employeeNumber?: string | null;
  role: string;
  balance: LeaveBalanceDetails;
}

export interface TeamCalendarLeave {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber?: string | null;
  type: string;
  from: string;
  to: string;
  days: number;
}

export interface BankHolidayItem {
  id: string;
  year: number;
  date: string;
  name: string;
  notes?: string | null;
  isActive?: boolean;
  weekday?: string;
  isPaid?: boolean;
  dayType?: string;
  createdAt?: number;
  updatedAt?: number;
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
  employeeNumber?: string | null;
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
  employeeNumber?: string | null;
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

/**
 * OPEN -> IN_REVIEW -> PUBLISHED -> PAID is the automated monthly run;
 * OPEN -> CLOSED is a legacy manual period. PUBLISHED, PAID and CLOSED are
 * final: nothing in them can be proposed, regenerated, re-rated or decided.
 */
export type PayrollPeriodStatus = 'OPEN' | 'IN_REVIEW' | 'PUBLISHED' | 'PAID' | 'CLOSED';

/** A row of GET /api/payroll/periods. Run timestamps are epoch ms. */
export interface PayrollPeriod {
  id: string;
  name: string;
  from: string;
  to: string;
  exchangeRate?: number;
  status: PayrollPeriodStatus;
  approvedBy: string | null;
  // T.displayTime() on this route: a time of day only, not a date.
  approvedAt: string | null;
  cutoffDate: string | null;
  payDate: string | null;
  autoCreated: boolean;
  generatedAt: number | null;
  publishedAt: number | null;
  publishedBy: string | null;
  paidAt: number | null;
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
  employeeNumber?: string | null;
  type: string;
  calculated: { days: number | null; amount: number | null };
  approved: { days: number | null; amount: number | null } | null;
  status: PayrollLineStatus;
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

// ---------------------------------------------------------------------------
// Payroll: the monthly run (review, approve, pay). Shapes are exactly what
// backend/src/routes/payroll.js and domain/payroll.js return.
// ---------------------------------------------------------------------------

export type PayrollLineStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED';

/** null only on rows from before migration 024 that were never classified. */
export type PayrollReviewLevel = 'ROUTINE' | 'ATTENTION';

/** presentPeriod(): the period as the review sheet and payslips list return it. */
export interface PayrollRunPeriod {
  id: string;
  name: string;
  from: string;
  to: string;
  status: PayrollPeriodStatus;
  exchangeRate: number;
  cutoffDate: string | null;
  payDate: string | null;
  autoCreated: boolean;
  generatedAt: number | null;
  publishedAt: number | null;
  publishedBy: string | null;
  paidAt: number | null;
  approvedBy: string | null;
  approvedAt: number | null;
}

export type PayrollPreflightCode =
  | 'PENDING_CORRECTIONS'
  | 'PENDING_ABSENCE_REVIEWS'
  | 'PENDING_LEAVE_REQUESTS'
  | 'NEW_DEDUCTIONS_SINCE_GENERATION'
  | 'NOT_YET_GENERATED'
  | 'NO_SALARY';

export type PayrollPreflightSeverity = 'BLOCKING' | 'WARNING' | 'INFO';

export interface PayrollPreflightItem {
  employeeId: string;
  employeeName: string | null;
  ref: string | null;
  date: string | null;
  detail: string;
}

/**
 * One failing check. count is the whole run's; items are limited to the
 * employees the caller may see, so there can be fewer items than count.
 */
export interface PayrollPreflightCheck {
  code: PayrollPreflightCode;
  severity: PayrollPreflightSeverity;
  count: number;
  message: string;
  items: PayrollPreflightItem[];
}

export interface PayrollPreflightResponse {
  periodId: string;
  blocking: boolean;
  preflight: PayrollPreflightCheck[];
}

/** presentAdjustment(): one line on the review sheet. approvedAt is epoch ms here. */
export interface PayrollReviewLine {
  id: string;
  type: string;
  status: PayrollLineStatus;
  calculatedAmount: number;
  approvedAmount: number | null;
  explanation: string;
  calculatedDays: number;
  approvedDays: number | null;
  sourceReference: string | null;
  reviewLevel: PayrollReviewLevel | null;
  reviewReasons: string[];
  approvedBy: string | null;
  approvedAt: number | null;
}

export type PayrollEmployeeFlagCode =
  | 'STARTER'
  | 'LEAVER'
  | 'LEAVER_AFTER_CUTOFF'
  | 'SALARY_CHANGED_IN_PERIOD'
  | 'NET_CHANGE_OVER_15_PERCENT';

export interface PayrollEmployeeFlag {
  code: PayrollEmployeeFlagCode;
  message: string;
  // NET_CHANGE_OVER_15_PERCENT only.
  previousNet?: number;
  changePercent?: number;
}

export interface PayrollReviewEmployee {
  employeeId: string;
  employeeName: string;
  employeeNumber: string | null;
  salary: { monthly: number; daily: number; annual: number; currency: string };
  isPartialPeriod: boolean;
  workingDaysCount: number;
  fullPeriodDays: number;
  grossBaseline: number;
  calculatedPeriodGross: number;
  /** The last date this row's deductions count: cut-off, period end, or a leaver's last day. */
  deductionsThrough: string;
  isStarter: boolean;
  starter: { startDate: string; eligibleWorkingDays: number; calculatedGross: number } | null;
  unpaidDays: {
    deficitDays: number;
    deficitAmount: number;
    deficitAdjustmentId: string | null;
    deficitStatus: PayrollLineStatus | null;
    absenceDays: number;
    absenceAmount: number;
    absenceRecordIds: string[];
    leaveDays: number;
    leaveAmount: number;
    leaveRequestIds: string[];
    totalDays: number;
    totalAmount: number;
  };
  netPayable: { amount: number; basis: 'PROVISIONAL' | 'PARTIALLY_DECIDED' | 'DECIDED' };
  attendanceDeficit: {
    wholeDayEquivalents: number;
    carryForwardMinutes: number;
    valueIfDeducted: number;
    needsHrDecision: boolean;
  };
  leave: { blocked: true; reason: string } | { blocked?: undefined; available: number; isNegative: boolean };
  adjustments: PayrollReviewLine[];
  /** Gross + approved lines + undecided lines at their calculated figure. */
  expectedNetPayable: number;
  employeeFlags: PayrollEmployeeFlag[];
}

/** Left out of the run: no salary on record, or not employed on any day of it. */
export interface PayrollExcludedEmployee {
  employeeId: string;
  employeeName: string;
  employeeNumber: string | null;
  reason: string;
  message: string;
}

/** Summed across employees as raw numbers, whatever each one's salary currency. */
export interface PayrollReviewTotals {
  employees: number;
  gross: number;
  deductions: number;
  net: number;
  routineCount: number;
  attentionCount: number;
  pendingCount: number;
  decidedCount: number;
}

export interface PayrollReviewSheet {
  period: PayrollRunPeriod;
  totals: PayrollReviewTotals;
  preflight: PayrollPreflightCheck[];
  employees: PayrollReviewEmployee[];
  excluded: PayrollExcludedEmployee[];
  note: string;
}

/** An explicit decision on one line, sent with approve-run. */
export interface PayrollRunDecision {
  adjustmentId: string;
  decision: 'APPROVED' | 'REJECTED';
  approvedAmount?: number;
  approvedDays?: number;
  notes?: string;
}

export interface PayrollApproveRunRequest {
  note: string;
  decisions: PayrollRunDecision[];
  waiveBlockers?: boolean;
  waiverNote?: string | null;
}

export interface PayrollApproveRunResult {
  periodId: string;
  periodStatus: 'PUBLISHED';
  publishedAt: number;
  publishedBy: string;
  payslipCount: number;
  excludedCount: number;
  totals: { gross: number; deductions: number; net: number };
  decided: { explicit: number; routineApproved: number };
  waivedBlockers: PayrollPreflightCode[];
}

export interface PayrollMarkPaidResult {
  periodId: string;
  periodStatus: 'PAID';
  paidAt: number;
  payslipsMarked: number;
}

export interface PayrollGenerateResult {
  periodId: string;
  createdCount: number;
  created: { employeeId: string; adjustmentType: string; id: string; status: PayrollLineStatus }[];
  employees: number;
  classification: { routine: number; attention: number };
}

export interface PayslipLine {
  adjustmentId: string;
  type: string;
  label: string;
  explanation: string;
  days: number | null;
  amount: number;
  sourceReference: string | null;
  date: string | null;
}

/** presentPayslip(). Written once at publish; integrityOk re-checks its hash. */
export interface Payslip {
  id: string;
  periodId: string;
  periodName: string | null;
  employeeId: string;
  employeeName: string | null;
  employeeNumber: string | null;
  version: number;
  status: 'PUBLISHED' | 'SUPERSEDED';
  payslipStatus: 'PUBLISHED' | 'PAID';
  currency: string;
  exchangeRate: number;
  monthlySalary: number;
  dailyRate: number;
  grossBaseline: number;
  deductionsTotal: number;
  adjustmentsTotal: number;
  netPayable: number;
  workingDays: number;
  fullPeriodDays: number;
  isPartial: boolean;
  isStarter: boolean;
  salaryEffectiveFrom: string | null;
  lines: PayslipLine[];
  cutoffDate: string | null;
  payDate: string | null;
  publishedAt: number;
  publishedBy: string;
  paidAt: number | null;
  contentHash: string;
  integrityOk: boolean;
}

export interface PayrollPayslipsResponse {
  period: PayrollRunPeriod;
  payslips: Payslip[];
}

/** One entry of an ATTENTION_UNDECIDED refusal's `undecided` list. */
export interface PayrollUndecidedLine {
  adjustmentId: string;
  employeeId: string;
  employeeName: string;
  type: string;
  calculatedAmount: number;
  calculatedDays: number;
  reviewLevel: PayrollReviewLevel | null;
  reviewReasons: string[];
}

export type PayrollRunErrorCode =
  | 'NOTE_REQUIRED'
  | 'WAIVER_NOTE_REQUIRED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'ALREADY_FINAL'
  | 'FORBIDDEN'
  | 'PREFLIGHT_BLOCKED'
  | 'ATTENTION_UNDECIDED'
  | 'NOT_PUBLISHED';

/** The { status: 'ERROR' } body of a refused run call, with its details spread in. */
export interface PayrollRunErrorBody {
  status: 'ERROR';
  code?: PayrollRunErrorCode;
  message: string;
  undecided?: PayrollUndecidedLine[];
  preflight?: PayrollPreflightCheck[];
  // requirePermission()'s 403.
  missing?: string[];
}

export interface AppReleaseItem {
  id: string;
  versionName: string;
  versionCode: number;
  platform: string;
  fileName: string | null;
  fileSize: number;
  downloadUrl: string;
  sha256: string | null;
  releaseNotes: string;
  mandatory: boolean;
  downloadCount: number;
  active: boolean;
  publishedAt: string;
  publishedAtMs: number;
  createdBy: string;
}

export interface OtaConfig {
  minSupportedVersionCode: number;
  iosTestflightUrl: string;
  iosEnterpriseManifestUrl: string;
  githubRepoOwner: string;
  githubRepoName: string;
}

export interface EmployeeDeviceItem {
  id: string;
  employeeId: string;
  platform: string;
  model: string;
  label?: string | null;
  enrolledAt: string;
  lastSeenAt: number | null;
  lastSeen: string;
  isRecentlyActive: boolean;
}

export interface EmployeeDevicesResponse {
  status: string;
  employee: {
    id: string;
    name: string;
    employeeNumber?: string | null;
  };
  devices: EmployeeDeviceItem[];
}

export interface WorkstationItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber?: string | null;
  employeeRole: string;
  deviceId: string;
  platform: string;
  model: string;
  label: string;
  // AGENT_STOPPED: the employee chose Exit on the laptop agent (it is logged in
  // the movements feed with the time); OUTSIDE_HOURS: outside their shift.
  status: 'ACTIVE' | 'IDLE' | 'ON_BREAK' | 'AWAY' | 'OFFLINE' | 'AGENT_STOPPED' | 'OUTSIDE_HOURS';
  activeMinutes: number;
  verifiedActiveMinutes?: number;
  unverifiedMinutes?: number;
  idleMinutes: number;
  breakMinutes: number;
  presenceMinutes?: number;
  inOffice: boolean | number;
  workMode?: 'IN_OFFICE' | 'REMOTE' | 'HYBRID';
  lockState: string;
  connectedBssid: string | null;
  lastHeartbeat: string;
}

export interface ProcessAnomalyItem {
  id: string;
  employeeId: string;
  employeeName: string;
  deviceModel: string;
  platform: string;
  processName: string;
  windowTitle: string | null;
  durationMinutes: number;
  detectedAt: string;
  detectedDate: string;
  resolved: boolean;
  notes: string | null;
}

export interface AppUsageItem {
  id: string;
  employeeId: string;
  employeeName: string;
  deviceModel: string;
  platform: string;
  appName: string;
  category?: 'WEBSITE' | 'APPLICATION';
  activeSeconds: number;
  activeMinutes: number;
  workstationActiveSeconds?: number;
  lastUsedAt: string;
}

/**
 * Where a live-view session stands (backend/src/routes/admin.js):
 * LIVE - frames flowing; STARTING - laptop acknowledged, first frame on its way;
 * WAITING - laptop hasn't checked in since the request; the rest explain why
 * no stream is possible right now.
 */
export type LivePhase =
  | 'LIVE'
  | 'STARTING'
  | 'WAITING'
  | 'OFFLINE'
  | 'PAUSED_BREAK'
  | 'OUTSIDE_HOURS'
  | 'ENDED';

export interface LiveFrameResponse {
  status: string;
  phase?: LivePhase;
  active: boolean;
  frameBase64: string | null;
  /** true when `since` matched the latest frame, so no image was sent. */
  unchanged?: boolean;
  lastFrameAt: number | null;
  lastActivityAt?: number | null;
  requestedAt?: number | null;
  streamStatus?: string;
  ackAt?: number | null;
  lastSeenAt?: number | null;
  isBreak: boolean;
  breakMessage?: string | null;
  agent?: { version: string | null; doorbell: boolean } | null;
  doorbellConfigured?: boolean;
  frameStore?: 'redis' | 'memory';
  warning?: 'LIVE_STORE_NOT_SHARED' | null;
  message?: string;
}

export interface LiveStreamRequestResponse {
  status: string;
  message: string;
  doorbell?: 'SENT' | 'FAILED' | 'UNAVAILABLE';
  frameStore?: 'redis' | 'memory';
  warning?: 'LIVE_STORE_NOT_SHARED' | null;
}

export interface ApproachingAnniversaryEmployee {
  employeeId: string;
  name: string;
  employeeNumber?: string | null;
  role: string;
  officialJoiningDate: string;
  cycleStartDate: string;
  cycleEndDate: string;
  nextRenewalDate: string;
  daysUntilAnniversary: number;
  availableDays: number;
  accruedDays: number;
  takenDays: number;
  maxEligibleCarryForward: number;
  potentialLapsedDays: number;
  carryForwardDecision: {
    approvedDays: number;
    lapsedDays: number;
    decision: string;
    approvedBy?: string;
    approvedAt?: number;
    notes?: string;
  } | null;
}

export interface HistoricalLeaveCycle {
  cycleIndex: number;
  cycleStartDate: string;
  cycleEndDate: string;
  renewalDate: string;
  status: 'COMPLETED' | 'ACTIVE';
  entitlementDays: number;
  accruedDays: number;
  takenDays: number;
  carriedForwardIn: number;
  lapsedDays: number;
  netClosingBalance: number;
  carryForwardRecord: {
    approvedDays: number;
    lapsedDays: number;
    decision: string;
    approvedBy?: string;
    approvedAt?: number;
    notes?: string;
  } | null;
}

export interface EmployeeAppBacklog {
  employee: {
    id: string;
    name: string;
    role: string;
    employee_number?: string | null;
  };
  range: {
    startDate?: string | null;
    endDate?: string | null;
  };
  totalActiveSeconds: number;
  totalActiveMinutes: number;
  topApps: Array<{
    appName: string;
    activeSeconds: number;
    activeMinutes: number;
    percentage: number;
  }>;
  dailyBreakdown: Array<{
    date: string;
    totalSeconds: number;
    totalMinutes: number;
    apps: Array<{
      appName: string;
      activeSeconds: number;
      activeMinutes: number;
      lastUsedAt: string;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Monthly Leave Entitlement Report
// ---------------------------------------------------------------------------

export interface MonthOption {
  monthKey: string;
  monthLabel: string;
  monthIndex: number;
  isCurrentMonth: boolean;
}

export interface LeaveAdjustmentEntry {
  id: string;
  adjustmentDate: string;
  days: number;
  reason: string;
  createdAt?: string;
}

export interface PendingLeaveRequestItem {
  id: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reducesEntitlement: boolean;
  status: string;
}

export interface RequestedLeaveSufficiency {
  hasPendingRequests: boolean;
  totalPendingDays: number;
  currentlyEntitledPaidLeave: number;
  status: 'NONE_PENDING' | 'SUFFICIENT' | 'INSUFFICIENT';
  shortfallDays: number;
  message: string;
  pendingRequests: PendingLeaveRequestItem[];
}

export interface MonthlyLeaveReport {
  employeeId: string;
  employeeName: string;
  role: string;
  employeeNumber?: string | null;
  monthKey: string;
  monthLabel: string;
  monthIndex: number;
  totalMonthsInCycle: number;
  cycleStartDate: string;
  cycleEndDate: string;
  asOfDate: string;
  totalAnnualEntitlement: number;
  leaveTakenAnnual: number;
  paidLeaveUsedAnnual: number;
  unpaidLeaveTakenAnnual: number;
  remainingLeaveBalance: number;
  leaveAccruedToDate: number;
  currentlyEntitledPaidLeave: number;
  plainEnglishSummary: string;
  plainEnglishDetail: string;
  monthWindow: {
    startDate: string;
    endDate: string;
    workingDaysInMonth: number;
    leaveTakenInMonth: number;
    paidLeaveInMonth: number;
    unpaidLeaveInMonth: number;
  };
  requestedLeaveSufficiency: RequestedLeaveSufficiency;
  monthAdjustments: LeaveAdjustmentEntry[];
  monthOptions: MonthOption[];
}

export interface ComplaintAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export type ComplaintStatus = 'SUBMITTED' | 'UNDER_REVIEW' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

export interface ComplaintRecord {
  id: string;
  referenceNumber: string;
  employeeId: string;
  employeeName: string;
  employeeNumber?: string | null;
  employeeRole?: string | null;
  category: string;
  subject: string;
  description: string;
  status: ComplaintStatus;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  hrNotes?: string | null;
  resolutionNotes?: string | null;
  resolvedAt?: number | null;
  resolvedAtFormatted?: string | null;
  resolvedBy?: string | null;
  createdAt: number;
  createdAtFormatted: string;
  updatedAt: number;
  attachments: ComplaintAttachment[];
}

export interface ScreenshotStorageStats {
  status: string;
  totalBytes: number;
  totalCount: number;
  quotaGb: number;
  quotaBytes: number;
  usedPercentage: number;
  retentionDays: number;
  employees: {
    employeeId: string;
    employeeName: string;
    screenshotEnabled: boolean;
    intervalMinutes: number;
    mode: 'ACTIVE_ONLY' | 'CONTINUOUS';
    shotCount: number;
    totalBytes: number;
    latestCaptureAt: number | null;
  }[];
}

export interface ScreenshotItem {
  id: string;
  employeeId: string;
  deviceId: string;
  dateKey: string;
  capturedAt: number;
  displayTime: string;
  storagePath: string;
  fileSizeBytes: number;
  mimeType: string;
  activeApp: string;
  windowTitle: string;
  captureStatus: string;
  imageUrl: string;
}

export interface EmployeeScreenshotsResponse {
  status: string;
  employee: {
    id: string;
    name: string;
    screenshotEnabled: boolean;
    intervalMinutes: number;
    mode: 'ACTIVE_ONLY' | 'CONTINUOUS';
  };
  dateKey: string;
  count: number;
  availableDates: {
    dateKey: string;
    count: number;
    totalBytes: number;
  }[];
  screenshots: ScreenshotItem[];
}

export interface ShiftPattern {
  id: string;
  name: string;
  workingDays: string;
  startTime: string;
  endTime: string;
  permittedBreakMinutes: number;
  dayEquivalentMinutes: number;
  graceMinutes: number;
  isDefault: boolean;
  active: boolean;
  createdAt: number;
}

