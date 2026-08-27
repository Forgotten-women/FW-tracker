#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>

// ==========================================
// 1. Wi-Fi Configuration
// ==========================================
const char* ssid     = "Trans K 2.4G";
const char* password = "kore#trans2.4g";

// ==========================================
// 2. Node.js Backend Server URL
// (Your PC's IP on Trans K 2.4G network)
// ==========================================
const char* backendUrl = "http://192.168.18.68:5000/api/attendance/heartbeat";
const char* officeId   = "main_branch";

// Timing
unsigned long lastScanTime = 0;
const unsigned long SCAN_INTERVAL = 30000; // Scan network every 30 seconds

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n\n==========================================");
  Serial.println("--- Office Tracker 24/7 ESP8266 Sentinel ---");
  Serial.println("==========================================");

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(ssid);

  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }

  Serial.println("\n[SUCCESS] Connected to Office Wi-Fi!");
  Serial.print("[INFO] ESP8266 IP Address: ");
  Serial.println(WiFi.localIP());
  Serial.print("[INFO] Target Backend: ");
  Serial.println(backendUrl);
  Serial.println("------------------------------------------\n");
}

// Sends detected active devices to Node.js Backend
void reportToBackend(String payload) {
  if (WiFi.status() == WL_CONNECTED) {
    WiFiClient client;
    HTTPClient http;
    http.begin(client, backendUrl);
    http.addHeader("Content-Type", "application/json");

    int httpCode = http.POST(payload);
    Serial.printf("[Sentinel] Report sent to Backend! HTTP Status: %d\n", httpCode);
    if (httpCode > 0) {
      String response = http.getString();
      Serial.println("  Backend Response: " + response);
    } else {
      Serial.printf("  Error sending report: %s\n", http.errorToString(httpCode).c_str());
    }
    http.end();
  }
}

// Sweeps the local subnet for active IP addresses
void scanSubnetAndReport() {
  IPAddress localIP = WiFi.localIP();
  Serial.println("\n[Sentinel] Scanning subnet 192.168.18.X for active phones/devices...");

  String json = "{\"office_id\":\"" + String(officeId) + "\",\"devices\":[";
  bool first = true;
  int foundCount = 0;

  // We scan common IP ranges on the subnet
  for (int i = 1; i <= 254; i++) {
    IPAddress targetIP(localIP[0], localIP[1], localIP[2], i);

    // Skip self
    if (targetIP == localIP) continue;

    // Multi-port probe to detect active Android/iOS devices even when locked
    WiFiClient probe;
    probe.setTimeout(15);

    if (probe.connect(targetIP, 80) || 
        probe.connect(targetIP, 443) || 
        probe.connect(targetIP, 5353) || 
        probe.connect(targetIP, 62078) || // Apple sync
        probe.connect(targetIP, 1031) ||  // ADB wireless
        probe.connect(targetIP, 5555) ||  // ADB standard
        probe.connect(targetIP, 8080) ||
        probe.connect(targetIP, 8000)) {
      probe.stop();
      foundCount++;
      if (!first) json += ",";
      json += "{\"ip\":\"" + targetIP.toString() + "\"}";
      first = false;
      Serial.print("  -> Found active device at IP: ");
      Serial.println(targetIP.toString());
    }
  }

  json += "]}";
  Serial.printf("[Sentinel] Scan completed. Found %d active devices.\n", foundCount);

  // Send to backend
  reportToBackend(json);
}

void loop() {
  // Run network sweep every 30 seconds
  if (millis() - lastScanTime > SCAN_INTERVAL || lastScanTime == 0) {
    lastScanTime = millis();
    scanSubnetAndReport();
  }

  delay(100);
}
