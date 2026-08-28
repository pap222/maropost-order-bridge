// QR lockbox firmware — Seeed XIAO ESP32-C3
//
// Serves a tiny web app on the local network. The QR code encodes the
// unlock URL (with a secret key); scanning it fires the solenoid for
// PULSE_MS. The reed switch reports whether the door is open or closed.
//
// Arduino IDE setup:
//   Boards Manager -> install "esp32" by Espressif, board "XIAO_ESP32C3"
//   Fill in WIFI_SSID / WIFI_PASS / UNLOCK_KEY below, then upload over USB-C.

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ---- configure me ----------------------------------------------------
const char *WIFI_SSID = "YOUR_WIFI_NAME";
const char *WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char *UNLOCK_KEY = "change-me-to-a-long-random-string";
#define RELAY_ACTIVE_LOW true // most cheap 5V relay modules are active-low
// ----------------------------------------------------------------------

const int PIN_RELAY = D1; // GPIO3 -> relay IN
const int PIN_REED = D2;  // GPIO4 -> reed switch (other leg to GND)

const unsigned long PULSE_MS = 1000;    // solenoid on-time per unlock
const unsigned long COOLDOWN_MS = 3000; // min gap between unlocks

WebServer server(80);
unsigned long lastUnlockAt = 0;

void relayWrite(bool on) {
  digitalWrite(PIN_RELAY, (on != RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

bool doorClosed() {
  // reed switch closes (reads LOW with pull-up) when the magnet is near
  return digitalRead(PIN_REED) == LOW;
}

String statusJson() {
  String s = "{\"door\":\"";
  s += doorClosed() ? "closed" : "open";
  s += "\"}";
  return s;
}

void handleRoot() {
  String html =
      "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>Lockbox</title>"
      "<body style='font-family:sans-serif;text-align:center;padding-top:3em'>"
      "<h1>Lockbox</h1>"
      "<p id=door>Door: ...</p>"
      "<script>"
      "setInterval(()=>fetch('/status').then(r=>r.json())"
      ".then(j=>door.textContent='Door: '+j.door),1000);"
      "</script>";
  server.send(200, "text/html", html);
}

void handleStatus() { server.send(200, "application/json", statusJson()); }

void handleUnlock() {
  if (server.arg("key") != UNLOCK_KEY) {
    server.send(403, "text/plain", "wrong key");
    return;
  }
  unsigned long now = millis();
  if (now - lastUnlockAt < COOLDOWN_MS) {
    server.send(429, "text/plain", "cooling down, try again in a moment");
    return;
  }
  lastUnlockAt = now;

  relayWrite(true);
  delay(PULSE_MS); // FIT0620 is intermittent duty: keep pulses short
  relayWrite(false);

  server.send(200, "text/html",
              "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
              "<body style='font-family:sans-serif;text-align:center;padding-top:3em'>"
              "<h1>Unlocked!</h1><p>Lift the lid now.</p>");
}

void setup() {
  pinMode(PIN_RELAY, OUTPUT);
  relayWrite(false); // make sure the solenoid is off from the first moment
  pinMode(PIN_REED, INPUT_PULLUP);

  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());

  if (MDNS.begin("lockbox")) {
    Serial.println("mDNS: http://lockbox.local/");
  }

  server.on("/", handleRoot);
  server.on("/status", handleStatus);
  server.on("/unlock", handleUnlock);
  server.begin();

  Serial.print("QR code should encode: http://");
  Serial.print(WiFi.localIP());
  Serial.print("/unlock?key=");
  Serial.println(UNLOCK_KEY);
}

void loop() { server.handleClient(); }
