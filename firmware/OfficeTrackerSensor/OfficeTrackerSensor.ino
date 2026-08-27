// ==========================================================================
// Office Tracker - ESP8266 presence sensor
//
// WHAT CHANGED AND WHY
//
// The previous firmware swept all 254 subnet IPs and tried to open TCP
// connections on ports 80/443/5353/62078/1031/5555/8080/8000. That approach
// cannot work:
//   * Modern phones close and firewall all inbound TCP. A locked, dozing
//     Android or iOS device accepts nothing.
//   * Port 5353 is mDNS, which is UDP only - that probe could never succeed.
//   * Port 62078 (iOS lockdownd) answers only while awake and unlocked.
// In practice it found routers, printers and desktops, not the phones it
// existed to find. It also risked a watchdog reset (254 x 8 blocking connects
// with no yield()) and fragmented the heap by building the payload with
// repeated String concatenation.
//
// This version listens instead of probing. In promiscuous (monitor) mode the
// radio reports the transmitter MAC and RSSI of every 802.11 frame it hears,
// including from locked and idle phones. That is what this chip is good at.
//
// TWO LIMITS TO BE AWARE OF
//  1. The ESP8266 radio is 2.4GHz only. It will NEVER see a device on the
//     5GHz band. If the office moves to 5GHz, this sensor goes blind and the
//     router/AP association log becomes the only viable network signal.
//  2. Sniffing and staying associated are mutually exclusive, because monitor
//     mode hops channels. So the loop alternates: sniff for a window, then
//     reconnect and upload.
//
// This sensor is CORROBORATION ONLY. Because of MAC randomisation it cannot
// identify a person, and the backend deliberately stores what it reports as
// unattributed, hashed sightings that never create attendance on their own.
// ==========================================================================

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <time.h>
#include <bearssl/bearssl_hmac.h>

extern "C" {
  #include "user_interface.h"
}

// Credentials and the HMAC shared secret live in secrets.h, which is
// gitignored. Copy secrets.h.example to secrets.h and fill it in.
// The old firmware had the office Wi-Fi password hardcoded here, so that
// password is permanently in git history and must be rotated.
#include "secrets.h"

// --- tuning ----------------------------------------------------------------

static const uint32_t SNIFF_WINDOW_MS    = 25000;  // listen before uploading
static const uint32_t CHANNEL_DWELL_MS   = 400;    // per channel while hopping
static const uint8_t  CHANNELS[]         = { 1, 6, 11 };  // non-overlapping 2.4GHz
static const uint8_t  NUM_CHANNELS       = sizeof(CHANNELS) / sizeof(CHANNELS[0]);

static const uint8_t  MAX_DEVICES        = 40;
static const int8_t   MIN_RSSI           = -85;    // ignore distant neighbours
static const uint32_t WIFI_TIMEOUT_MS    = 20000;
static const uint8_t  MAX_UPLOAD_RETRIES = 3;

// Fixed-size storage. Nothing here allocates from the heap during the sniff
// loop, which is what makes long uptimes possible on a ~40KB heap.
struct Sighting {
  uint8_t  mac[6];
  int8_t   rssi;
  uint32_t lastSeenMs;
};

static Sighting devices[MAX_DEVICES];
static uint8_t  deviceCount = 0;
static char     payload[4096];
static char     signatureHex[65];

// --- 802.11 frame structures ----------------------------------------------

struct RxControl {
  signed   rssi:8;
  unsigned rate:4;
  unsigned is_group:1;
  unsigned:1;
  unsigned sig_mode:2;
  unsigned legacy_length:12;
  unsigned damatch0:1;
  unsigned damatch1:1;
  unsigned bssidmatch0:1;
  unsigned bssidmatch1:1;
  unsigned MCS:7;
  unsigned CWB:1;
  unsigned HT_length:16;
  unsigned Smoothing:1;
  unsigned Not_Sounding:1;
  unsigned:1;
  unsigned Aggregation:1;
  unsigned STBC:2;
  unsigned FEC_CODING:1;
  unsigned SGI:1;
  unsigned rxend_state:8;
  unsigned ampdu_cnt:8;
  unsigned channel:4;
  unsigned:12;
};

struct SnifferPacket {
  struct RxControl rx_ctrl;
  uint8_t  buf[112];
  uint16_t cnt;
  uint16_t len;
};

// --- sighting table --------------------------------------------------------

static bool isMulticast(const uint8_t* mac) {
  // Bit 0 of the first octet marks group/multicast addresses. Broadcast and
  // multicast frames do not represent a device that is present.
  return (mac[0] & 0x01) != 0;
}

static void recordSighting(const uint8_t* mac, int8_t rssi) {
  if (rssi < MIN_RSSI) return;
  if (isMulticast(mac)) return;

  for (uint8_t i = 0; i < deviceCount; i++) {
    if (memcmp(devices[i].mac, mac, 6) == 0) {
      // Keep the strongest reading - it best reflects actual proximity.
      if (rssi > devices[i].rssi) devices[i].rssi = rssi;
      devices[i].lastSeenMs = millis();
      return;
    }
  }

  if (deviceCount >= MAX_DEVICES) return;   // table full, drop silently
  memcpy(devices[deviceCount].mac, mac, 6);
  devices[deviceCount].rssi = rssi;
  devices[deviceCount].lastSeenMs = millis();
  deviceCount++;
}

// Promiscuous callback. Must stay short: it runs in the Wi-Fi driver context,
// so no printing, no allocation and no blocking.
static void ICACHE_FLASH_ATTR snifferCallback(uint8_t* buf, uint16_t len) {
  if (len < 36) return;   // too short to contain addr2

  const SnifferPacket* pkt = (SnifferPacket*)buf;
  // Address 2 is the transmitter, at offset 10 of the 802.11 MAC header.
  const uint8_t* addr2 = pkt->buf + 10;
  recordSighting(addr2, (int8_t)pkt->rx_ctrl.rssi);
}

// --- sniffing --------------------------------------------------------------

static void sniffWindow() {
  Serial.println(F("[sniff] entering monitor mode"));

  WiFi.disconnect();
  wifi_set_opmode(STATION_MODE);
  wifi_promiscuous_enable(0);
  wifi_set_promiscuous_rx_cb(snifferCallback);
  wifi_promiscuous_enable(1);

  const uint32_t start = millis();
  uint8_t channelIndex = 0;

  while (millis() - start < SNIFF_WINDOW_MS) {
    wifi_set_channel(CHANNELS[channelIndex]);
    channelIndex = (channelIndex + 1) % NUM_CHANNELS;

    const uint32_t dwellStart = millis();
    while (millis() - dwellStart < CHANNEL_DWELL_MS) {
      // Yielding to the Wi-Fi stack and feeding the watchdog is exactly what
      // the old 254-IP blocking scan loop never did.
      delay(10);
      yield();
    }
  }

  wifi_promiscuous_enable(0);
  Serial.printf("[sniff] window complete, %u distinct device(s)\n", deviceCount);
}

// --- connectivity ----------------------------------------------------------

static bool connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_TIMEOUT_MS) {
      Serial.println(F("[wifi] connect timed out"));
      return false;
    }
    delay(250);
    yield();
  }

  Serial.printf("[wifi] connected, ip=%s rssi=%d\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  return true;
}

// The backend rejects signatures whose timestamp is more than five minutes
// from server time, so the clock has to be real. millis() is not enough.
static bool syncClock() {
  if (time(nullptr) > 1700000000UL) return true;   // already sane

  Serial.print(F("[time] syncing via NTP"));
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  const uint32_t start = millis();
  while (time(nullptr) < 1700000000UL) {
    if (millis() - start > 15000) {
      Serial.println(F(" FAILED"));
      return false;
    }
    delay(300);
    Serial.print('.');
    yield();
  }
  Serial.println(F(" ok"));
  return true;
}

// --- payload and signing ---------------------------------------------------

static void buildPayload(unsigned long epochSeconds) {
  size_t offset = 0;
  offset += snprintf(payload + offset, sizeof(payload) - offset, "{\"devices\":[");

  for (uint8_t i = 0; i < deviceCount; i++) {
    if (offset > sizeof(payload) - 96) break;   // always leave room to close
    offset += snprintf(
      payload + offset, sizeof(payload) - offset,
      "%s{\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"rssi\":%d,\"at\":%lu000}",
      (i == 0 ? "" : ","),
      devices[i].mac[0], devices[i].mac[1], devices[i].mac[2],
      devices[i].mac[3], devices[i].mac[4], devices[i].mac[5],
      devices[i].rssi, epochSeconds
    );
  }

  snprintf(payload + offset, sizeof(payload) - offset, "]}");
}

// HMAC-SHA256 over "<timestampMs>.<body>", matching requireSensor() in
// backend/src/middleware/auth.js. BearSSL ships with the ESP8266 core.
static void signPayload(const char* timestampMs, const char* body) {
  br_hmac_key_context keyCtx;
  br_hmac_key_init(&keyCtx, &br_sha256_vtable, SENSOR_SECRET, strlen(SENSOR_SECRET));

  br_hmac_context ctx;
  br_hmac_init(&ctx, &keyCtx, 0);
  br_hmac_update(&ctx, timestampMs, strlen(timestampMs));
  br_hmac_update(&ctx, ".", 1);
  br_hmac_update(&ctx, body, strlen(body));

  uint8_t digest[32];
  br_hmac_out(&ctx, digest);

  for (uint8_t i = 0; i < 32; i++) {
    snprintf(signatureHex + (i * 2), 3, "%02x", digest[i]);
  }
  signatureHex[64] = '\0';
}

static bool uploadReport() {
  if (deviceCount == 0) {
    Serial.println(F("[upload] nothing seen this window, skipping"));
    return true;
  }
  if (!connectWifi()) return false;
  if (!syncClock()) return false;

  const unsigned long epochSeconds = (unsigned long)time(nullptr);
  char timestampMs[24];
  snprintf(timestampMs, sizeof(timestampMs), "%lu000", epochSeconds);

  buildPayload(epochSeconds);
  signPayload(timestampMs, payload);

  char url[128];
  snprintf(url, sizeof(url), "http://%s:%d/api/attendance/heartbeat", BACKEND_HOST, BACKEND_PORT);

  for (uint8_t attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(8000);

    if (!http.begin(client, url)) {
      Serial.println(F("[upload] http.begin failed"));
      return false;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Sensor-Id", SENSOR_ID);
    http.addHeader("X-Timestamp", timestampMs);
    http.addHeader("X-Signature", signatureHex);

    const int code = http.POST((uint8_t*)payload, strlen(payload));

    if (code == 200) {
      Serial.printf("[upload] accepted %u device(s)\n", deviceCount);
      http.end();
      return true;
    }

    // A 401 means the signature or the clock is wrong. Retrying identical
    // bytes will not help, and the backend rejects replays anyway.
    if (code == 401) {
      Serial.printf("[upload] REJECTED (401): %s\n", http.getString().c_str());
      Serial.println(F("[upload] check SENSOR_SECRET matches the backend, and the clock"));
      http.end();
      return false;
    }

    Serial.printf("[upload] attempt %u/%u failed, code=%d\n", attempt, MAX_UPLOAD_RETRIES, code);
    http.end();
    if (attempt < MAX_UPLOAD_RETRIES) {
      delay(1000UL * attempt);   // linear backoff
      yield();
    }
  }

  return false;
}

// --- lifecycle -------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\n\n=========================================="));
  Serial.println(F("  Office Tracker - ESP8266 presence sensor"));
  Serial.printf ("  Sensor id : %s\n", SENSOR_ID);
  Serial.printf ("  Backend   : %s:%d\n", BACKEND_HOST, BACKEND_PORT);
  Serial.println(F("  Mode      : passive 802.11 monitor (2.4GHz only)"));
  Serial.println(F("=========================================="));

  WiFi.persistent(false);   // stop rewriting flash on every connect
  WiFi.setAutoReconnect(true);

  if (connectWifi()) syncClock();
}

void loop() {
  deviceCount = 0;

  sniffWindow();

  if (!uploadReport()) {
    Serial.println(F("[loop] report not delivered this cycle"));
  }

  // Free heap is the number to watch: if it trends downward over hours there
  // is a leak. The old String-concatenation payload fragmented it steadily.
  Serial.printf("[loop] free heap: %u bytes, uptime: %lus\n",
                ESP.getFreeHeap(), millis() / 1000UL);

  delay(2000);
  yield();
}
