-- Identity and role-based access control.
--
-- Spec section 3. Until now the only credentials were a single shared
-- ADMIN_API_KEY and per-device tokens, so there was no way to tell one HR user
-- from another in the audit log - which is unusable for a payroll system where
-- "who changed this salary" has to have an answer.
--
-- The permission model is deliberately granular rather than role-name checks in
-- code, because spec section 3.2 requires managers to reach attendance for
-- their own reports while being blocked from passports, addresses, bank
-- details, next-of-kin, medical records and salary unless explicitly granted.

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

-- A login account. Separate from `employees`: not every employee needs a login,
-- and some logins (a payroll administrator, an auditor) are not employees.
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT NOT NULL,
  -- scrypt, stored as salt:hash. Never a reversible or unsalted digest.
  password_hash  TEXT,
  employee_id    TEXT REFERENCES employees(id) ON DELETE SET NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  -- Spec section 27 requires MFA for HR/Admin/Super Admin.
  mfa_secret     TEXT,
  mfa_enabled    INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER,
  last_login_at  INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_employee ON users(employee_id);
CREATE INDEX IF NOT EXISTS idx_users_active   ON users(active);

-- Spec section 27: login history and suspicious-login detection.
CREATE TABLE IF NOT EXISTS login_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  email_tried TEXT,
  at          INTEGER NOT NULL,
  outcome     TEXT NOT NULL,      -- SUCCESS | BAD_PASSWORD | LOCKED | NO_USER | MFA_FAILED
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, at);
CREATE INDEX IF NOT EXISTS idx_login_events_at   ON login_events(at);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);

-- Spec section 27: secure password reset.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- ---------------------------------------------------------------------------
-- Roles and permissions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,          -- employee | manager | hr | super_admin
  name        TEXT NOT NULL,
  description TEXT,
  -- Built-in roles cannot be deleted; their permissions can still be edited.
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id          TEXT PRIMARY KEY,          -- e.g. employee.personal.read
  category    TEXT NOT NULL,
  description TEXT NOT NULL,
  -- Marks the permissions spec 3.2 says a manager must NOT receive by default.
  is_sensitive INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at  INTEGER NOT NULL,
  granted_by  TEXT,
  PRIMARY KEY (user_id, role_id)
);

-- A one-off grant to a single user, so HR can give one manager access to one
-- sensitive area without inventing a new role. Spec 3.2: "These should require
-- explicit permission."
CREATE TABLE IF NOT EXISTS user_permission_grants (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at    INTEGER NOT NULL,
  granted_by    TEXT NOT NULL,
  expires_at    INTEGER,
  reason        TEXT,
  PRIMARY KEY (user_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- Organisation structure
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS office_locations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  time_zone   TEXT NOT NULL,
  country     TEXT,
  address     TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES departments(id) ON DELETE SET NULL,
  head_employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_departments_parent ON departments(parent_id);

-- Which employees a manager may see. Spec 3.2: "Can access assigned employees
-- only" - so this is an explicit list, never inferred from job title.
CREATE TABLE IF NOT EXISTS manager_assignments (
  manager_employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assigned_at         INTEGER NOT NULL,
  assigned_by         TEXT,
  ended_at            INTEGER,
  PRIMARY KEY (manager_employee_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_manager_assignments_emp ON manager_assignments(employee_id);

-- ---------------------------------------------------------------------------
-- Configurable organisation settings (spec section 30)
-- ---------------------------------------------------------------------------

-- Values that must be policy decisions rather than constants in code. Held in
-- the database so Super Admin can change them and every change is audited.
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  value_type  TEXT NOT NULL DEFAULT 'string',  -- string | number | boolean | json
  category    TEXT NOT NULL,
  description TEXT,
  -- True where the spec explicitly says the organisation has not decided yet
  -- (section 35). Engines refuse to act on these rather than assuming.
  requires_decision INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES
  ('employee',    'Employee',    'Own record only. Cannot see other employees.', 1, 0),
  ('manager',     'Manager',     'Assigned reports only. No sensitive personal data without an explicit grant.', 1, 0),
  ('hr',          'HR / Admin',  'Full employee administration, attendance, leave and payroll preparation.', 1, 0),
  ('super_admin', 'Super Admin', 'All areas, including policy configuration and security logs.', 1, 0);

INSERT OR IGNORE INTO permissions (id, category, description, is_sensitive) VALUES
  -- self
  ('self.read',                  'self',       'View own profile, attendance and leave', 0),
  ('self.leave.request',         'self',       'Submit own leave requests', 0),
  ('self.attendance.correct',    'self',       'Submit own attendance correction requests', 0),
  ('self.document.read',         'self',       'View own permitted documents', 0),
  ('self.warning.acknowledge',   'self',       'Acknowledge warnings issued to self', 0),

  -- employee records
  ('employee.read',              'employee',   'View basic employment information', 0),
  ('employee.write',             'employee',   'Create and edit employee records', 0),
  ('employee.personal.read',     'employee',   'View home address, date of birth, personal contact details', 1),
  ('employee.identity.read',     'employee',   'View passport, ID and right-to-work documents', 1),
  ('employee.bank.read',         'employee',   'View bank account details', 1),
  ('employee.nextofkin.read',    'employee',   'View next-of-kin and emergency contacts', 1),
  ('employee.medical.read',      'employee',   'View sickness and medical documentation', 1),
  ('employee.salary.read',       'employee',   'View salary and salary history', 1),
  ('employee.salary.write',      'employee',   'Change salary (creates a new salary history row)', 1),

  -- attendance
  ('attendance.read',            'attendance', 'View attendance records', 0),
  ('attendance.write',           'attendance', 'Manually add or adjust attendance', 0),
  ('attendance.correction.review','attendance','Approve or reject attendance corrections', 0),
  ('attendance.import',          'attendance', 'Import historical attendance data', 0),

  -- leave
  ('leave.read',                 'leave',      'View leave balances and requests', 0),
  ('leave.approve',              'leave',      'Approve or reject leave requests', 0),
  ('leave.write',                'leave',      'Adjust leave entitlement and balances', 0),

  -- warnings
  ('warning.read',               'warning',    'View warning status and triggers', 0),
  ('warning.issue',              'warning',    'Confirm or waive a warning trigger, issue formal warnings', 0),

  -- documents
  ('document.read',              'document',   'View non-confidential employee documents', 0),
  ('document.write',             'document',   'Upload and replace employee documents', 0),

  -- payroll
  ('payroll.read',               'payroll',    'View payroll preparation figures', 1),
  ('payroll.approve',            'payroll',    'Approve payroll adjustments', 1),

  -- reports and admin
  ('report.read',                'report',     'Run and export reports', 0),
  ('settings.read',              'admin',      'View organisation settings', 0),
  ('settings.write',             'admin',      'Change attendance, leave, warning and payroll policy', 1),
  ('user.manage',                'admin',      'Create and manage user accounts and roles', 1),
  ('device.manage',              'admin',      'Manage enrolled phones and ESP8266 sensors', 0),
  ('audit.read',                 'admin',      'Read the security and audit log', 1);

-- Employee: own data only.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'employee', id FROM permissions WHERE category = 'self';

-- Manager: assigned reports, operational data only. Deliberately excludes every
-- is_sensitive permission - spec 3.2 lists passports, addresses, bank details,
-- next-of-kin, medical records and salary as requiring explicit permission.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'manager', id FROM permissions WHERE id IN (
    'self.read', 'self.leave.request', 'self.attendance.correct',
    'self.document.read', 'self.warning.acknowledge',
    'employee.read', 'attendance.read', 'leave.read', 'leave.approve',
    'warning.read', 'report.read'
  );

-- HR: everything operational, including sensitive employee data and payroll
-- preparation, but not policy configuration or user administration.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'hr', id FROM permissions WHERE id NOT IN (
    'settings.write', 'user.manage'
  );

-- Super Admin: everything.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'super_admin', id FROM permissions;
