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

### 2. Office networks

Edit `backend/config/office.json`. Add one entry per SSID and band. Find your
BSSIDs on Windows with:

```bash
netsh wlan show interfaces
```

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
