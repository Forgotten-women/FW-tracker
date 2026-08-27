# ESP8266 sensor

## What this device does in the architecture

It is a **corroborating location sensor**. It answers "is *a* device physically
present on the office Wi-Fi right now", and nothing more.

It deliberately **cannot** answer "who is here". That question is answered only
by the authenticated phone app, because:

- **MAC randomisation** — iOS 14+ and Android 10+ use a different MAC per SSID,
  and iOS 18 / Android 14 rotate it periodically. A MAC is not a stable identity.
- **DHCP lease reuse** — today's `192.168.18.59` was someone else's last week.

The old firmware tried to do identity anyway, and the backend matched employees
on `deviceMac` or `deviceIp`. That could put one person's hours on another
person's payroll record. So sightings from this sensor are stored **hashed and
unattributed**, at confidence 0.3–0.5, and never create attendance on their own.

What it is genuinely good for:

| Use | How |
|---|---|
| Confirming the office network is live | Reports stop arriving if it goes down |
| Corroborating app heartbeats | An independent sighting at the same time |
| Spotting unknown devices | Unrecognised MACs on the office Wi-Fi |
| Rough occupancy | Distinct device count, useful even without identity |

### Hard limits, worth knowing before you rely on it

1. **2.4GHz only.** The ESP8266 radio cannot see 5GHz at all. In this office
   that matters concretely: of roughly 29 connected stations surveyed, 13 were
   on the 2.4GHz radio (`ba:9f:cc:db:52:58`, channel 11) and 16 were on 5GHz
   radios this sensor is deaf to. If the office moves primarily to 5GHz, the
   access point's own association log becomes the only viable network signal —
   implement `backend/src/sensors/router.js` for it.
2. **Sniffing and being connected are mutually exclusive.** Monitor mode hops
   channels, so the firmware alternates: listen for 25 s, then reconnect and
   upload.
3. **It hears neighbours too.** Anything within range is captured, which is why
   MACs are hashed with a per-install salt and expire after 7 days.

## Flashing with two files in Arduino IDE

This is why the code moved into a folder. **Arduino IDE requires the sketch to
live in a folder whose name matches the `.ino` file.** Every other file in that
folder is compiled with it and shows up as a tab. That is the whole mechanism —
there is no "add file" step in the upload dialog.

```
firmware/OfficeTrackerSensor/
  OfficeTrackerSensor.ino     <- folder name and file name must match
  secrets.h                   <- picked up automatically, appears as a tab
  secrets.h.example
```

### Steps

1. Copy the template and fill it in:

```bash
cd firmware/OfficeTrackerSensor && cp secrets.h.example secrets.h
```

2. Open `firmware/OfficeTrackerSensor/OfficeTrackerSensor.ino` in Arduino IDE
   (File → Open, then pick the `.ino`). You will see **two tabs** at the top:
   `OfficeTrackerSensor` and `secrets.h`. That is it — both compile together.

3. Select the board: Tools → Board → ESP8266 Boards → your model
   (NodeMCU 1.0, Wemos D1 Mini, etc.), then pick the right port.

4. Upload.

### If you would rather create the file inside the IDE

You do not have to create `secrets.h` on disk first:

- **Arduino IDE 2.x** — click the **`⋯`** button on the right of the tab bar →
  **New Tab**, type `secrets.h` (include the extension), press OK.
- **Arduino IDE 1.x** — the **▾** arrow at the far right of the tab bar →
  **New Tab**, same thing.

The new tab is saved as a real file in the sketch folder. Paste the contents of
`secrets.h.example` into it and fill in your values.

### Why not just put the credentials in the .ino?

They were, and that is the problem: the office Wi-Fi password is now permanently
in this repository's git history and must be rotated. `secrets.h` is gitignored,
so credentials stay off the repo.

### Required libraries

Only the ESP8266 core (Tools → Board → Boards Manager → "esp8266"). BearSSL,
used for HMAC signing, ships with it. No extra libraries.

## Verifying it works

Open Serial Monitor at **115200 baud**. A healthy cycle looks like:

```
[sniff] entering monitor mode
[sniff] window complete, 7 distinct device(s)
[wifi] connected, ip=192.168.18.81 rssi=-58
[upload] accepted 7 device(s)
[loop] free heap: 31240 bytes, uptime: 142s
```

At boot it locates the office 2.4GHz radio and locks onto that channel, which
captures roughly three times more frames than sweeping 1/6/11 blindly. It
re-checks every 15 minutes, because routers move their 2.4GHz channel on their
own:

```
[scan] office 2.4GHz radio on channel 11 (rssi -62)
```

**Watch the free heap.** If it trends downward over hours there is a leak — the
old String-concatenation payload fragmented it steadily, which is why the
payload is now a fixed `char[4096]` buffer.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `REJECTED (401)` with `BAD_SIGNATURE` | `SENSOR_SECRET` does not match `SENSOR_SECRET_esp_main_01` in `backend/.env` |
| `REJECTED (401)` with `STALE` | Clock is wrong. NTP sync failed — check the device can reach the internet |
| `UNKNOWN_SENSOR` | `SENSOR_ID` has no matching secret. `esp-main-01` maps to `SENSOR_SECRET_esp_main_01` (dashes and dots become underscores) |
| Watchdog resets | Should not happen; the sniff loop yields. If it does, lower `CHANNEL_DWELL_MS` |
| Sees nothing | Check the office is on 2.4GHz, and that `MIN_RSSI` (-85) is not too strict |
| `[scan] no 2.4GHz radio found` | `WIFI_SSID` in `secrets.h` resolves only to a 5GHz radio. Point it at the SSID that has a 2.4GHz radio |
