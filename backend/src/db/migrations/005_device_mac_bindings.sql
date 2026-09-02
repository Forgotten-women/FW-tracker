-- Device-to-employee MAC bindings.
--
-- THE FIX for presence collapsing when the employee closes the app.
--
-- The problem: attendance was driven by app heartbeats. Close the app and the
-- heartbeats stop, so `last seen` froze at the moment it was closed and the
-- person was marked away while still sitting in the office. Mobile operating
-- systems are entitled to kill background work, so this was never solvable by
-- trying harder to keep the app alive.
--
-- The fix, and it is spec section 23.2 almost word for word:
--
--   The app ESTABLISHES identity. The ESP MAINTAINS presence.
--
--   1. The employee opens the app. It authenticates with its device-bound
--      token, so the server knows exactly who this is.
--   2. The server correlates that authenticated request's source IP against
--      what the network sensors are seeing right now, and learns which MAC
--      address belongs to that employee.
--   3. From then on a passive sighting of that MAC counts as presence for that
--      employee - no app required, no background execution required.
--   4. When the phone leaves the office Wi-Fi the sightings stop, and the
--      normal grace period marks them away. Which is the correct behaviour,
--      because this time they really have left.
--
-- This does NOT reintroduce the identity problem that made network sensors
-- unattributed in the first place. A MAC is still never used to GUESS who
-- someone is. It is only used to keep following an identity that an
-- authenticated app already proved. The binding expires, and re-proving it
-- requires opening the app again.

CREATE TABLE IF NOT EXISTS device_mac_bindings (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id         TEXT REFERENCES devices(id) ON DELETE CASCADE,
  -- Salted hash, matching how sensors store what they see. The real MAC is
  -- never written down.
  mac_hash          TEXT NOT NULL,

  bound_at          INTEGER NOT NULL,
  -- Refreshed every time the app proves the binding again.
  last_confirmed_at INTEGER NOT NULL,
  -- Phones rotate their per-network MAC (iOS 18, Android 14), so a binding is
  -- deliberately short-lived rather than permanent.
  expires_at        INTEGER NOT NULL,

  -- IP_CORRELATION : matched an authenticated ping to a network sighting
  -- ESP_CHALLENGE  : the phone talked to the ESP directly (stronger, see below)
  -- MANUAL         : an administrator bound it by hand
  bound_via         TEXT NOT NULL,
  bound_ip          TEXT,
  -- Lower than a live app heartbeat. Presence carried by a binding is real
  -- evidence, but it is inference from a proof made earlier, and a dispute
  -- should be able to see that.
  confidence        REAL NOT NULL DEFAULT 0.7,

  revoked_at        INTEGER,
  revoked_reason    TEXT
);

-- A MAC belongs to at most one employee at a time. Without this, a recycled
-- DHCP lease or a cloned address could attribute one person's hours to another
-- - which is exactly the failure the old deviceIp/deviceMac matching had.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mac_binding_active
  ON device_mac_bindings(mac_hash) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mac_binding_employee
  ON device_mac_bindings(employee_id) WHERE revoked_at IS NULL;

-- Every bind, rebind and revoke. Attendance derived from a binding has to be
-- explainable months later: "why was this person marked present at 4pm when
-- their app was closed" needs an answer.
CREATE TABLE IF NOT EXISTS mac_binding_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id   TEXT,
  employee_id  TEXT,
  mac_hash     TEXT,
  at           INTEGER NOT NULL,
  -- BOUND | CONFIRMED | EXPIRED | REVOKED | REBOUND | CONFLICT
  event_type   TEXT NOT NULL,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_mac_binding_events_at ON mac_binding_events(at);
