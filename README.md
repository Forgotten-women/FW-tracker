# Office Tracker

Wi-Fi based office attendance tracking: a Node.js backend, a Flutter employee
app, and an ESP8266 network sensor.

## How presence is established

**The authenticated phone app is the only source that can establish identity.**
It is the sole participant that holds a credential proving who it belongs to.
Network sensors corroborate *location*; they never name a person, because MAC
randomisation (iOS 14+, Android 10+) and DHCP lease reuse make MAC-to-person and
IP-to-person mapping unsound.

```
  Flutter app (authenticated, PRIMARY)  ─┐
  ESP8266 sniffer (corroboration)       ─┼─→  presence_events (append-only)
  ARP sensor (low confidence)           ─┤          │
  Admin correction (audited)            ─┘          ▼
                                             derivation (replay)
                                                    │
                                     ┌──────────────┴──────────────┐
                                     ▼                             ▼
                               live status (SSE)         daily attendance / payroll
```

Presence events are **append-only**. Attendance is **derived** by replaying them,
never mutated in place. That gives a real audit trail, and lets any day be
recomputed from scratch after a rule change or a bug fix
(`POST /api/admin/recompute`).

### Anti-buddy-punching

A heartbeat counts as office presence only if **both** hold:

1. the reported **BSSID** is on the office allowlist, and
2. the request **source IP** is inside a configured office subnet.

A ping from home fails both and is recorded as `REMOTE`, which never accrues
attendance. Both radios of a dual-band access point are simply two allowlisted
BSSIDs, so a 2.4/5GHz split needs no special handling.

> Until you add BSSIDs to `backend/config/office.json`, verification falls back
> to source-IP only. The server logs a warning at startup and the dashboard
> shows a banner.

## Layout

```
backend/     Node.js API + SQLite (port 5000, API only)
dashboard/   Next.js admin dashboard (port 3000)
forgottenwomen/  Flutter employee app
firmware/OfficeTrackerSensor/  ESP8266 sketch
```

## Setup

### 1. Backend

```bash
cd backend && npm install
```

Create `backend/.env` (gitignored):

```bash
cd backend && cp .env.example .env
```

Generate the keys it needs:

```bash
cd backend && npm run genkey
```

Set `ADMIN_API_KEY` to one generated value and `SENSOR_SECRET_esp_main_01` to
another. Then import any existing `data/db.json`:

```bash
cd backend && npm run migrate
```

Start it:

```bash
cd backend && npm start
```

The backend is API-only on port 5000. The dashboard is a separate Next.js app.

### 1b. Dashboard (Next.js)

```bash
cd dashboard && npm install
```

```bash
cd dashboard && npm run dev
```

Open `http://localhost:3000` and enter the admin key.

`dashboard/next.config.ts` proxies `/api/*` to the backend, so the browser stays
same-origin with the dashboard and never makes a cross-origin request. That is
why the backend's CORS can stay locked down instead of being opened up for the
dashboard's origin. Point it elsewhere with `API_ORIGIN` (see
`dashboard/.env.example`).

For production:

```bash
cd dashboard && npm run build && npm start
```

### 2. Office networks and BSSIDs

An SSID is just a name - anyone can create a network called `Trans K 2.4G`. A
**BSSID is the MAC address of a specific access point radio**, which is what
makes it usable as proof of location. Each radio has its own, so a dual-band
router has at least two.

Discover them:

```bash
cd backend && npm run bssids
```

Then list every radio in `backend/config/office.json`.

**`netsh` serves a cached scan**, so a radio that exists may not appear in any
single run - run it a few times and cross-check the router admin page before
deciding the list is complete.

Enabling enforcement is a deliberate second step:

```json
"enforceBssid": true
```

While it is `false` the BSSIDs are recorded but not checked, and verification
falls back to source IP. Turn it on only once you have confirmed every radio
staff actually connect to is listed - **a missing radio silently stops counting
everyone on it.** The server prints how many are listed and whether they are
being enforced at startup, and the dashboard shows a banner.

> Watch out for SSID names that lie about their band. In this office the SSID
> named `Trans K 2.4G` runs on *both* the 2.4GHz radio (channel 11) and a 5GHz
> radio (channel 40). Drive the config from the scan, never from the name.

### 3. Employee app

```bash
cd forgottenwomen && flutter pub get && flutter run
```

Enrolment: an admin clicks **Pair device** on the dashboard, which issues a
single-use code valid for 24 hours. The employee types it into the app, which
exchanges it for a device-bound token stored in the platform keystore.

### 4. ESP8266 sensor

```bash
cd firmware/OfficeTrackerSensor && cp secrets.h.example secrets.h
```

Fill in `secrets.h` (gitignored), setting `SENSOR_SECRET` to the same value as
`SENSOR_SECRET_esp_main_01` in `backend/.env`. Then open
`firmware/OfficeTrackerSensor/OfficeTrackerSensor.ino` in Arduino IDE and upload.

The sketch lives in a folder because **Arduino IDE requires the folder name to
match the `.ino` file**, and every other file in that folder compiles with it.
That is how `secrets.h` gets included — it appears as a second tab
automatically. See [firmware/README.md](firmware/README.md) for the full
walkthrough and what this sensor is and is not for.

## Tests

```bash
cd backend && npm test
```

```bash
cd forgottenwomen && flutter test
```

```bash
cd dashboard && npm run build
```

## Operations

| Task | Command |
|---|---|
| Backup the database | `cd backend && npm run backup` |
| Rebuild derived attendance | `POST /api/admin/recompute` |
| Export for payroll | `GET /api/admin/export?from=YYYY-MM-DD&to=YYYY-MM-DD` |
| Audit trail | `GET /api/admin/audit` |
| Correct someone's hours | `POST /api/admin/attendance/:employeeId/:dateKey/adjust` |

Corrections are **additive and require a note**. The underlying event log is
never edited, so the original sensor record and the adjustment are both visible.

A nightly backup runs automatically into `backend/data/backups/`.

## Data protection

This system records employee presence and feeds payroll, so it holds personal
data under UK GDPR.

- **Consent** is requested in the app before any tracking begins, with a plain
  description of what is and is not collected.
- **Retention**: raw `presence_events` are pruned after 90 days
  (`config/office.json` → `retention`). Derived daily hours are retained as the
  payroll record.
- **Non-employee devices** seen on the office Wi-Fi are stored as salted hashes
  on a 7-day TTL, never as raw MACs.
- **Access control**: all employee data is behind the admin key.
- `backend/data/` is gitignored. Never commit it — it contains names, device
  identifiers and movement history.

## Security notes

- `ADMIN_API_KEY` gates all employee data and every mutation.
- Device tokens and enrolment codes are stored **hashed**; a database leak
  yields no usable credential.
- Sensor reports are HMAC-signed with a ±5 minute freshness window and a replay
  cache.
- `TRUST_PROXY` is **off** by default. Only set it if a reverse proxy actually
  sits in front, and set it to that proxy's address rather than `true` —
  presence location is verified from the request source IP, so trusting
  `X-Forwarded-For` from anyone would let a client claim an office IP with a
  header.
- The office Wi-Fi password was previously hardcoded in the firmware and is
  in this repository's git history. **It must be rotated.**

## Users, roles and permissions

The HR platform (spec sections 3-5) uses real user accounts, not a shared key.
The `ADMIN_API_KEY` still exists for machine access and bootstrap, but it cannot
say *who* acted - which is unusable for a payroll audit trail.

Create the first account:

```bash
cd backend && npm run user:create -- --email you@example.org --name "Your Name" --role super_admin
```

The password is read from `OFFICE_TRACKER_PASSWORD` or generated and printed
once. It is never passed as a command-line argument, because argv is visible to
other processes and lands in shell history.

### The four roles

| Role | Sees | Notably cannot |
|---|---|---|
| `employee` | Own record only | Anything about anyone else |
| `manager` | Assigned reports only | Passports, addresses, bank details, next-of-kin, medical records, salary |
| `hr` | Whole workforce, including sensitive data and payroll preparation | Change policy, manage user accounts |
| `super_admin` | Everything | — |

Two checks run on every request, and they answer different questions:

- **Permission** — *may this user do this kind of thing?* (`attendance.read`)
- **Employee access** — *may this user do it to this person?*

Holding `attendance.read` does not imply reading everyone's attendance. A
manager has it for their assigned reports and nobody else. Conflating the two is
how a workforce-wide leak happens, so they are enforced separately
(`requirePermission` and `requireEmployeeAccess`).

Managers deliberately receive **no** sensitive permissions by default, per spec
3.2. To grant one without inventing a new role, insert a row into
`user_permission_grants` — optionally with an expiry. A grant widens *which
fields*, never *which people*.

### Schema changes

Migrations in `backend/src/db/migrations/` run automatically at startup and are
recorded in `schema_migrations`, so they apply exactly once.

```bash
cd backend && npm run migrate:status
```

Once a migration has run it is immutable — editing it makes deployments disagree
about the shape of a database holding payroll data. Add a new migration instead.
The runner warns if a checksum changes.

### Policy left undecided on purpose

Spec section 35 lists decisions the organisation has not made. Where a default
would silently invent policy, the value is stored as **undecided** and the
engine refuses to act rather than guessing:

| Setting | State | Why it matters |
|---|---|---|
| `latenessMonitoringPeriod` | `UNSET` | Decides whether 3 late arrivals reset monthly, quarterly or never — i.e. who gets a warning |
| `latenessGraceMinutes` | `0` | Whether 11:01 is automatically late |
| Unauthorised absence | 3 separate switches, no defaults | The wording supplied would deduct a day's leave *and* a day's pay for the same absence |

