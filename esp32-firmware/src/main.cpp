#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <Preferences.h>
#include <esp_bt.h>
#include <esp_wifi.h>
#include <esp_task_wdt.h>
#include <vector>
#include "embedded_source.h"

// =========================================================================
// VERSI FIRMWARE & IDENTITAS PERANGKAT (SDN AGENT v2.1.9)
// =========================================================================
#define FIRMWARE_VERSION "2.1.9"

#if defined(CONFIG_IDF_TARGET_ESP32S3)
  #define BOARD_TYPE "ESP32_S3"
#else
  #define BOARD_TYPE "ESP32_CP2102"
#endif

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const char* SERVER_BASE = "http://192.168.1.100:3000";
const char* DEVICE_API_KEY = "CHANGE_ME_DEVICE_API_KEY";
const char* DOOR_ID = "pintu-utama";

// =========================================================================
// DEFINISI PIN GPIO ESP32 (OTOMATIS SESUAI BOARD: CP2102 vs ESP32-S3)
// =========================================================================
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  // Pin aman untuk ESP32-S3 (hindari GPIO 19/20 USB, 26-37 Flash/PSRAM, 0/3/45/46 strapping)
  const int PIN_RELAY = 4;   // Modul Relay 5V (Active HIGH)
  const int PIN_D0    = 5;   // Wiegand Data 0 (Hijau via Shifter LV1)
  const int PIN_D1    = 6;   // Wiegand Data 1 (Putih via Shifter LV2)
  const int PIN_BEEP  = 7;   // Buzzer Reader  (Kuning via Shifter LV3)
  const int PIN_EXIT  = 15;  // Tombol Exit    (Baut 1 ke GPIO15, Baut 2 ke GND)
  const int PIN_LED   = 16;  // LED Reader     (Biru/Coklat "LED" via Shifter LV4) LOW=Hijau, HIGH=Merah
#else
  // Pin standar ESP32 CP2102 + Shield DT-Y6593
  const int PIN_RELAY = 4;   // Modul Relay 5V (Active HIGH / Jumper H)
  const int PIN_D0    = 18;  // Wiegand Data 0 (Hijau via Shifter LV1)
  const int PIN_D1    = 19;  // Wiegand Data 1 (Putih via Shifter LV2)
  const int PIN_BEEP  = 23;  // Buzzer Reader  (Kuning via Shifter LV3)
  const int PIN_EXIT  = 27;  // Tombol Exit    (Baut 1 ke D27, Baut 2 ke GND)
  const int PIN_LED   = 25;  // LED Reader     (Biru/Coklat "LED" via Shifter LV4) LOW=Hijau, HIGH=Merah
#endif

// =========================================================================
// SDN RUNTIME POLICY (DIKENDALIKAN TERPUSAT DARI CLOUD, DISIMPAN DI NVS)
// =========================================================================
struct SdnPolicy {
  unsigned long version = 0;
  bool antiBruteforce = true;
  int maxFails = 3;
  int lockoutSec = 15;
  unsigned long sameCardCooldownMs = 2000;
  bool exitInLockdown = false;
  bool buzzerEnabled = true;
  unsigned long heartbeatIntervalMs = 2500;
};
SdnPolicy sdnPolicy;

// =========================================================================
// STATUS PINTU, DURASI & SINKRONISASI SERVER
// =========================================================================
String currentMode = "NORMAL"; // NORMAL | HOLD_OPEN | LOCKDOWN
String otaStatus = "IDLE";
bool isRelayUnlocked = false;
const unsigned long MAX_UNLOCK_MS = 60000; // Batas aman fleksibel hingga 60 detik
unsigned long defaultUnlockMs = 7000;     // Default 7 detik (otomatis ikut setting per-ESP32 di Web)
unsigned long unlockTimer = 0;
unsigned long lastHeartbeat = 0;

// =========================================================================
// ANTI-SPAM & ANTI-BRUTEFORCE TAP KARTU
// =========================================================================
unsigned long lastTappedUid = 0;
unsigned long lastTappedTime = 0;
int consecutiveFails = 0;
unsigned long tapCooldownUntil = 0;
unsigned long lockoutUntil = 0;
unsigned long lastLockoutBeep = 0;

// =========================================================================
// MEMORI OFFLINE NVS FLASH (CLOUD-SYNCED CARDS + BACKUP SUPERADMIN)
// =========================================================================
struct OfflineCardEntry {
  unsigned long uid;
  unsigned long durationMs; // 0 = ikut defaultUnlockMs ESP32, >0 = durasi khusus kartu
};

Preferences prefs;
unsigned long savedCardSyncVersion = 0;
std::vector<OfflineCardEntry> syncedLocalCards;
const unsigned long EMERGENCY_ADMIN_CARDS[] = {1078426UL, 1957786UL};
const int EMERGENCY_ADMIN_COUNT = sizeof(EMERGENCY_ADMIN_CARDS) / sizeof(EMERGENCY_ADMIN_CARDS[0]);

// Wiegand Buffer
volatile unsigned long cardData = 0;
volatile int bitCount = 0;
volatile unsigned long lastBitTime = 0;

// Debounce Tombol Exit
unsigned long lastExitButtonPress = 0;

// =========================================================================
// INTERRUPT SERVICE ROUTINES (WIEGAND)
// =========================================================================
void IRAM_ATTR isrD0() {
  bitCount = bitCount + 1;
  cardData = (cardData << 1);
  lastBitTime = millis();
}

void IRAM_ATTR isrD1() {
  bitCount = bitCount + 1;
  cardData = (cardData << 1) | 1;
  lastBitTime = millis();
}

// Kontrol Buzzer Beeper di Reader (Active LOW via Shifter)
void readerBeep(int durationMs = 120, int count = 1, int gapMs = 80) {
  if (!sdnPolicy.buzzerEnabled) return;
  for (int i = 0; i < count; i++) {
    digitalWrite(PIN_BEEP, LOW); // Beep ON
    delay(durationMs);
    digitalWrite(PIN_BEEP, HIGH); // Beep OFF
    if (i < count - 1) delay(gapMs);
    esp_task_wdt_reset();
  }
}

// Pola 3x Beep Sukses / Buka Pintu: "beep ..(300ms) beep(100ms) beep(100ms)"
void readerBeepSuccess() {
  if (!sdnPolicy.buzzerEnabled) return;
  digitalWrite(PIN_BEEP, LOW);  delay(100);  // Beep 1
  digitalWrite(PIN_BEEP, HIGH); delay(300);  // Jeda .. (300 ms)
  digitalWrite(PIN_BEEP, LOW);  delay(100);  // Beep 2
  digitalWrite(PIN_BEEP, HIGH); delay(100);  // Jeda (100 ms)
  digitalWrite(PIN_BEEP, LOW);  delay(100);  // Beep 3
  digitalWrite(PIN_BEEP, HIGH);
  esp_task_wdt_reset();
}

// Pola 2x Beep Ekor untuk Tap Kartu (beep ke-1 sudah dari bawaan reader Wiegand):
// [beep reader] ..(250ms) beep(100ms) (100ms) beep(100ms)
void readerBeepCardTail() {
  if (!sdnPolicy.buzzerEnabled) return;
  delay(250);
  digitalWrite(PIN_BEEP, LOW);  delay(100);  // Beep 2
  digitalWrite(PIN_BEEP, HIGH); delay(100);  // Jeda (100 ms)
  digitalWrite(PIN_BEEP, LOW);  delay(100);  // Beep 3
  digitalWrite(PIN_BEEP, HIGH);
  esp_task_wdt_reset();
}

// LED Reader: LOW = HIJAU (diterima / pintu terbuka), HIGH = MERAH (terkunci / ditolak)
void readerLed(bool green) {
  digitalWrite(PIN_LED, green ? LOW : HIGH);
}

// Akses ditolak: pastikan LED tetap MERAH (pintu tidak dibuka)
void readerLedReject() {
  if (!isRelayUnlocked) readerLed(false);
}

// Buka / Kunci Relay Pintu Fisik
void applyRelayState(bool unlock) {
  isRelayUnlocked = unlock;
  digitalWrite(PIN_RELAY, unlock ? HIGH : LOW);
  readerLed(unlock);
}

// Trigger Buka Pintu Sesaat (Auto-Lock)
void unlockDoor(unsigned long durationMs = 0) {
  unsigned long ms = (durationMs > 0) ? durationMs : defaultUnlockMs;
  if (ms > MAX_UNLOCK_MS) ms = MAX_UNLOCK_MS;
  Serial.printf("[RELAY] Pintu DIBUKA selama %lu ms!\n", ms);
  applyRelayState(true);
  unlockTimer = millis() + ms;
}

// =========================================================================
// PARSER JSON RINGAN
// =========================================================================
unsigned long extractNumberField(const String& json, const String& key, unsigned long fallback) {
  int idx = json.indexOf("\"" + key + "\":");
  if (idx < 0) return fallback;
  int start = idx + key.length() + 3;
  while (start < (int)json.length() && (json[start] == ' ' || json[start] == '"')) start++;
  unsigned long val = strtoul(json.substring(start).c_str(), nullptr, 10);
  return val > 0 ? val : fallback;
}

String extractStringField(const String& json, const String& key) {
  String pattern = "\"" + key + "\":\"";
  int idx = json.indexOf(pattern);
  if (idx < 0) return "";
  int start = idx + pattern.length();
  int end = json.indexOf("\"", start);
  if (end < 0) return "";
  return json.substring(start, end);
}

bool extractBoolField(const String& json, const String& key, bool fallback = false) {
  String pattern = "\"" + key + "\":";
  int idx = json.indexOf(pattern);
  if (idx < 0) return fallback;
  int start = idx + pattern.length();
  while (start < (int)json.length() && json[start] == ' ') start++;
  if (json.startsWith("true", start)) return true;
  if (json.startsWith("false", start)) return false;
  return fallback;
}

// =========================================================================
// SDN POLICY PERSISTENCE (NVS FLASH)
// =========================================================================
void loadSdnPolicyFromNVS() {
  prefs.begin("sdn_policy", true);
  sdnPolicy.version = prefs.getULong("ver", 0);
  sdnPolicy.antiBruteforce = prefs.getBool("antiBf", true);
  sdnPolicy.maxFails = prefs.getInt("maxFail", 3);
  sdnPolicy.lockoutSec = prefs.getInt("lockSec", 15);
  sdnPolicy.sameCardCooldownMs = prefs.getULong("sameCd", 2000);
  sdnPolicy.exitInLockdown = prefs.getBool("exitLck", false);
  sdnPolicy.buzzerEnabled = prefs.getBool("buzz", true);
  sdnPolicy.heartbeatIntervalMs = prefs.getULong("hbMs", 2500);
  prefs.end();

  if (sdnPolicy.maxFails < 1) sdnPolicy.maxFails = 3;
  if (sdnPolicy.lockoutSec < 5) sdnPolicy.lockoutSec = 15;
  if (sdnPolicy.heartbeatIntervalMs < 1000 || sdnPolicy.heartbeatIntervalMs > 30000) {
    sdnPolicy.heartbeatIntervalMs = 2500;
  }

  Serial.printf("[SDN POLICY] Loaded v%lu (AntiBF=%d, MaxFail=%d, Lockout=%ds, ExitInLockdown=%d, Buzzer=%d, HB=%lums)\n",
                sdnPolicy.version, sdnPolicy.antiBruteforce, sdnPolicy.maxFails,
                sdnPolicy.lockoutSec, sdnPolicy.exitInLockdown, sdnPolicy.buzzerEnabled,
                sdnPolicy.heartbeatIntervalMs);
}

void saveSdnPolicyToNVS() {
  prefs.begin("sdn_policy", false);
  prefs.putULong("ver", sdnPolicy.version);
  prefs.putBool("antiBf", sdnPolicy.antiBruteforce);
  prefs.putInt("maxFail", sdnPolicy.maxFails);
  prefs.putInt("lockSec", sdnPolicy.lockoutSec);
  prefs.putULong("sameCd", sdnPolicy.sameCardCooldownMs);
  prefs.putBool("exitLck", sdnPolicy.exitInLockdown);
  prefs.putBool("buzz", sdnPolicy.buzzerEnabled);
  prefs.putULong("hbMs", sdnPolicy.heartbeatIntervalMs);
  prefs.end();
}

void syncSdnPolicyFromServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(SERVER_BASE) + "/api/device/policy?deviceId=" + String(DOOR_ID));
  http.addHeader("x-api-key", DEVICE_API_KEY);
  http.setConnectTimeout(2000);
  http.setTimeout(2500);

  int code = http.GET();
  if (code == 200) {
    String resp = http.getString();
    sdnPolicy.version = extractNumberField(resp, "policyVersion", sdnPolicy.version);
    sdnPolicy.antiBruteforce = extractBoolField(resp, "antiBruteforce", true);
    sdnPolicy.maxFails = (int)extractNumberField(resp, "bruteforceMaxFails", 3);
    sdnPolicy.lockoutSec = (int)extractNumberField(resp, "lockoutDurationSec", 15);
    sdnPolicy.sameCardCooldownMs = extractNumberField(resp, "sameCardCooldownMs", 2000);
    sdnPolicy.exitInLockdown = extractBoolField(resp, "exitInLockdown", false);
    sdnPolicy.buzzerEnabled = extractBoolField(resp, "buzzerEnabled", true);
    sdnPolicy.heartbeatIntervalMs = extractNumberField(resp, "heartbeatIntervalMs", 2500);
    saveSdnPolicyToNVS();
    Serial.printf("[SDN POLICY] Synced & applied v%lu from Cloud!\n", sdnPolicy.version);
  }
  http.end();
}

// =========================================================================
// MANAJEMEN MEMORI KARTU LOKAL (NVS FLASH + EMERGENCY ADMIN)
// =========================================================================
void loadOfflineCardsFromNVS() {
  prefs.begin("access_cfg", true);
  savedCardSyncVersion = prefs.getULong("syncVer", 0);
  String csv = prefs.getString("uids", "");
  prefs.end();

  syncedLocalCards.clear();
  int start = 0;
  while (start < (int)csv.length()) {
    int comma = csv.indexOf(',', start);
    String token = (comma >= 0) ? csv.substring(start, comma) : csv.substring(start);
    token.trim();
    if (token.length() > 0) {
      int colon = token.indexOf(':');
      unsigned long uid = 0;
      unsigned long durMs = 0;
      if (colon > 0) {
        uid = strtoul(token.substring(0, colon).c_str(), nullptr, 10);
        durMs = strtoul(token.substring(colon + 1).c_str(), nullptr, 10);
      } else {
        uid = strtoul(token.c_str(), nullptr, 10);
      }
      if (uid > 0) syncedLocalCards.push_back({uid, durMs});
    }
    if (comma < 0) break;
    start = comma + 1;
  }

  Serial.printf("[NVS] Memori offline dimuat: v%lu (%u kartu tersinkron + %d emergency admin)\n",
                savedCardSyncVersion, (unsigned int)syncedLocalCards.size(), EMERGENCY_ADMIN_COUNT);
}

void saveOfflineCardsToNVS(unsigned long newVersion, const String& csvUids) {
  prefs.begin("access_cfg", false);
  prefs.putULong("syncVer", newVersion);
  prefs.putString("uids", csvUids);
  prefs.end();
  loadOfflineCardsFromNVS();
}

bool isAuthorizedOffline(unsigned long uid, unsigned long& outDurationMs) {
  outDurationMs = 0;
  for (size_t i = 0; i < syncedLocalCards.size(); i++) {
    if (syncedLocalCards[i].uid == uid) {
      outDurationMs = syncedLocalCards[i].durationMs;
      return true;
    }
  }
  for (int i = 0; i < EMERGENCY_ADMIN_COUNT; i++) {
    if (EMERGENCY_ADMIN_CARDS[i] == uid) return true;
  }
  return false;
}

void syncCardsFromServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(SERVER_BASE) + "/api/device/sync-cards?deviceId=" + String(DOOR_ID);
  http.begin(url);
  http.addHeader("x-api-key", DEVICE_API_KEY);
  http.setConnectTimeout(2000);
  http.setTimeout(2500);

  int code = http.GET();
  if (code == 200) {
    String resp = http.getString();
    unsigned long serverVer = extractNumberField(resp, "cardSyncVersion", 0);
    int arrKeyIdx = resp.indexOf("\"entries\":[");
    int arrOffset = 11;
    if (arrKeyIdx < 0) {
      arrKeyIdx = resp.indexOf("\"uids\":[");
      arrOffset = 8;
    }
    if (arrKeyIdx >= 0) {
      int arrStart = arrKeyIdx + arrOffset;
      int arrEnd = resp.indexOf("]", arrStart);
      if (arrEnd >= arrStart) {
        String rawArr = resp.substring(arrStart, arrEnd);
        String csv = "";
        int pos = 0;
        while (pos < (int)rawArr.length()) {
          int q1 = rawArr.indexOf('"', pos);
          if (q1 < 0) break;
          int q2 = rawArr.indexOf('"', q1 + 1);
          if (q2 < 0) break;
          String u = rawArr.substring(q1 + 1, q2);
          u.trim();
          if (u.length() > 0) {
            if (csv.length() > 0) csv += ",";
            csv += u;
          }
          pos = q2 + 1;
        }
        if (serverVer > 0) {
          saveOfflineCardsToNVS(serverVer, csv);
          Serial.printf("[CLOUD SYNC] Daftar kartu offline diperbarui ke v%lu!\n", serverVer);
        }
      }
    }
  } else {
    Serial.printf("[CLOUD SYNC] Gagal sinkron kartu (HTTP %d)\n", code);
  }
  http.end();
}

// =========================================================================
// SDN INTROSPECTION: UPLOAD ISI SOURCE CODE & FULL TELEMETRY KE CLOUD
// =========================================================================
void uploadEmbeddedSourceToServer() {
  if (WiFi.status() != WL_CONNECTED) return;
  esp_task_wdt_reset();

  HTTPClient http;
  http.begin(String(SERVER_BASE) + "/api/device/source-upload");
  http.addHeader("Content-Type", "text/plain");
  http.addHeader("x-api-key", DEVICE_API_KEY);
  http.addHeader("x-device-id", DOOR_ID);
  http.addHeader("x-code-hash", FIRMWARE_CODE_HASH);
  http.addHeader("x-firmware-version", FIRMWARE_VERSION);
  http.setConnectTimeout(2500);
  http.setTimeout(5000);

  // Kirim langsung source code asli dari Flash ROM tanpa alokasi string tambahan
  int code = http.POST((uint8_t*)EMBEDDED_SOURCE_CODE, EMBEDDED_SOURCE_LEN);
  Serial.printf("[SDN INSPECT] Upload source code asli (#%s, %d bytes) -> HTTP %d\n",
                FIRMWARE_CODE_HASH, EMBEDDED_SOURCE_LEN, code);
  http.end();
  esp_task_wdt_reset();
}

void sendFullTelemetryToServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  String nvsArr = "[";
  for (size_t i = 0; i < syncedLocalCards.size(); i++) {
    if (i > 0) nvsArr += ",";
    nvsArr += "\"" + String(syncedLocalCards[i].uid) + ":" + String(syncedLocalCards[i].durationMs) + "\"";
  }
  nvsArr += "]";

  String payload = "{";
  payload += "\"deviceId\":\"" + String(DOOR_ID) + "\",";
  payload += "\"boardType\":\"" + String(BOARD_TYPE) + "\",";
  payload += "\"chipModel\":\"" + String(ESP.getChipModel()) + "\",";
  payload += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\",";
  payload += "\"codeHash\":\"" + String(FIRMWARE_CODE_HASH) + "\",";
  payload += "\"codeSha256\":\"" + String(FIRMWARE_CODE_SHA256) + "\",";
  payload += "\"sourceBytes\":" + String(EMBEDDED_SOURCE_LEN) + ",";
  payload += "\"uptimeSec\":" + String(millis() / 1000) + ",";
  payload += "\"freeHeapKb\":" + String(ESP.getFreeHeap() / 1024) + ",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"bssid\":\"" + WiFi.BSSIDstr() + "\",";
  payload += "\"channel\":" + String((int)WiFi.channel()) + ",";
  payload += "\"txPower\":" + String((int)WiFi.getTxPower()) + ",";
  payload += "\"defaultUnlockMs\":" + String(defaultUnlockMs) + ",";
  payload += "\"pins\":{\"relay\":" + String(PIN_RELAY) + ",\"d0\":" + String(PIN_D0) +
             ",\"d1\":" + String(PIN_D1) + ",\"beep\":" + String(PIN_BEEP) + ",\"exit\":" + String(PIN_EXIT) + ",\"led\":" + String(PIN_LED) + "},";
  payload += "\"nvsUids\":" + nvsArr;
  payload += "}";

  HTTPClient http;
  http.begin(String(SERVER_BASE) + "/api/device/telemetry");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);
  http.setConnectTimeout(2000);
  http.setTimeout(2500);
  int code = http.POST(payload);
  Serial.printf("[SDN TELEMETRY] Snapshot terkirim -> HTTP %d\n", code);
  http.end();
}

// =========================================================================
// CLOUD HTTP OTA UPDATE (UPDATE MASSAL TANPA KABEL USB)
// =========================================================================
void performCloudOTA(const String& targetVer, const String& expectedMd5) {
  Serial.println("\n========================================================");
  Serial.printf(" 🚀 [CLOUD OTA] Memulai Update: v%s ➔ v%s\n", FIRMWARE_VERSION, targetVer.c_str());
  Serial.println("========================================================");

  otaStatus = "UPDATING_TO_" + targetVer;
  readerBeep(90, 2);

  if (currentMode != "HOLD_OPEN") {
    applyRelayState(false);
  }

  WiFiClient client;
  HTTPClient otaHttp;
  String url = String(SERVER_BASE) + "/api/device/firmware.bin";
  otaHttp.begin(client, url);
  otaHttp.addHeader("x-api-key", DEVICE_API_KEY);
  otaHttp.setConnectTimeout(5000);
  otaHttp.setTimeout(15000);

  httpUpdate.rebootOnUpdate(true);
  if (expectedMd5.length() == 32) {
    httpUpdate.setMD5sum(expectedMd5);
  }

  httpUpdate.onProgress([](int cur, int total) {
    esp_task_wdt_reset();
    static int lastPct = -10;
    if (total > 0) {
      int pct = (cur * 100) / total;
      if (pct >= lastPct + 20) {
        lastPct = pct;
        Serial.printf(" [CLOUD OTA] Progress: %d%% (%d / %d bytes)\n", pct, cur, total);
      }
    }
  });

  t_httpUpdate_return ret = httpUpdate.update(otaHttp, FIRMWARE_VERSION);
  otaHttp.end();

  switch (ret) {
    case HTTP_UPDATE_FAILED:
      otaStatus = "FAILED_" + String(httpUpdate.getLastError());
      Serial.printf("❌ [CLOUD OTA] Gagal (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
      break;
    case HTTP_UPDATE_NO_UPDATES:
      otaStatus = "IDLE";
      Serial.println("[CLOUD OTA] Tidak ada update baru.");
      break;
    case HTTP_UPDATE_OK:
      otaStatus = "SUCCESS";
      Serial.println("✅ [CLOUD OTA] Berhasil! Reboot otomatis...");
      delay(500);
      ESP.restart();
      break;
  }
}

// =========================================================================
// KOMUNIKASI EVENT KE SERVER (EXIT, TAP, BRUTEFORCE ALERT, HEARTBEAT)
// =========================================================================
void sendSecurityAlert(unsigned long uid, const String& details) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(SERVER_BASE) + "/api/device/event");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);
  http.setConnectTimeout(1500);
  http.setTimeout(1500);

  String payload = "{\"deviceId\":\"" + String(DOOR_ID) +
                   "\",\"type\":\"BRUTEFORCE_ALERT\",\"cardUid\":\"" + String(uid) +
                   "\",\"details\":\"" + details + "\"}";
  http.POST(payload);
  http.end();
}

void sendExitButtonEvent() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(SERVER_BASE) + "/api/device/event");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);
  http.setConnectTimeout(1500);
  http.setTimeout(1500);

  String payload = "{\"deviceId\":\"" + String(DOOR_ID) + "\",\"type\":\"EXIT_BUTTON\"}";
  int code = http.POST(payload);
  if (code > 0) {
    Serial.printf("[HTTP] Exit Button event tercatat di server (Code: %d)\n", code);
  }
  http.end();
}

void registerFailedAttempt(unsigned long uid) {
  readerLedReject();
  if (!sdnPolicy.antiBruteforce) {
    readerBeep(80, 3);
    return;
  }
  consecutiveFails++;
  unsigned long now = millis();

  if (consecutiveFails >= sdnPolicy.maxFails + 2) {
    unsigned long penMs = (unsigned long)sdnPolicy.lockoutSec * 3000UL;
    if (penMs < 30000) penMs = 60000;
    lockoutUntil = now + penMs;
    Serial.printf("🚨 [ANTI-BRUTEFORCE] %dx salah beruntun! Reader DIKUNCI %lu detik!\n", consecutiveFails, penMs / 1000);
    readerBeep(650, 1);
    sendSecurityAlert(uid, "Bruteforce berat (" + String(consecutiveFails) + "x salah). Reader dikunci " + String(penMs / 1000) + " detik.");
  } else if (consecutiveFails >= sdnPolicy.maxFails) {
    unsigned long penMs = (unsigned long)sdnPolicy.lockoutSec * 1000UL;
    lockoutUntil = now + penMs;
    Serial.printf("⚠️ [ANTI-BRUTEFORCE] %dx salah beruntun! Reader DIKUNCI %d detik!\n", consecutiveFails, sdnPolicy.lockoutSec);
    readerBeep(120, 4);
    sendSecurityAlert(uid, "Peringatan Bruteforce (" + String(consecutiveFails) + "x salah). Reader dikunci " + String(sdnPolicy.lockoutSec) + " detik.");
  } else {
    tapCooldownUntil = now + 2500;
    Serial.printf("[COOLDOWN] Salah %dx. Jeda 2.5 detik sebelum tap berikutnya.\n", consecutiveFails);
    readerBeep(80, 3);
  }
}

void resetFailedAttempts() {
  consecutiveFails = 0;
  tapCooldownUntil = 0;
  lockoutUntil = 0;
}

bool sendCardTapToServer(unsigned long uid, bool applyAuthAction = true) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }
  HTTPClient http;
  http.begin(String(SERVER_BASE) + "/api/device/event");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);
  http.setConnectTimeout(1500);
  http.setTimeout(1500);

  String payload = "{\"deviceId\":\"" + String(DOOR_ID) +
                   "\",\"type\":\"RFID_IN\",\"cardUid\":\"" + String(uid) + "\"}";
  int code = http.POST(payload);

  if (code == 200) {
    String resp = http.getString();
    Serial.printf("[HTTP] Tap diverifikasi server (Code %d): %s\n", code, resp.c_str());

    if (applyAuthAction) {
      if (resp.indexOf("\"allow\":true") >= 0 || resp.indexOf("\"allow\": true") >= 0) {
        resetFailedAttempts();
        unsigned long duration = extractNumberField(resp, "unlockDurationMs", defaultUnlockMs);
        Serial.printf("[AKSES DITERIMA - SERVER] Pintu terbuka %lu ms!\n", min(duration, MAX_UNLOCK_MS));
        unlockDoor(duration);
        readerBeepCardTail();
      } else {
        Serial.println("[AKSES DITOLAK - SERVER] Kartu tidak berizin / belum terdaftar!");
        registerFailedAttempt(uid);
      }
    }
    http.end();
    return true;
  } else {
    Serial.printf("[HTTP FAILOVER] Server lambat / mati (Code: %d). Beralih ke NVS Lokal...\n", code);
    http.end();
    return false;
  }
}

void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(SERVER_BASE) + "/api/device/heartbeat");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);
  http.setConnectTimeout(1500);
  http.setTimeout(1500);

  String payload = "{\"deviceId\":\"" + String(DOOR_ID) +
                   "\",\"rssi\":" + String(WiFi.RSSI()) +
                   ",\"ip\":\"" + WiFi.localIP().toString() + "\"" +
                   ",\"bssid\":\"" + WiFi.BSSIDstr() + "\"" +
                   ",\"channel\":" + String((int)WiFi.channel()) +
                   ",\"txPower\":" + String((int)WiFi.getTxPower()) +
                   ",\"isRelayUnlocked\":" + (isRelayUnlocked ? "true" : "false") +
                   ",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\"" +
                   ",\"boardType\":\"" + String(BOARD_TYPE) + "\"" +
                   ",\"chipModel\":\"" + String(ESP.getChipModel()) + "\"" +
                   ",\"codeHash\":\"" + String(FIRMWARE_CODE_HASH) + "\"" +
                   ",\"cardSyncVersion\":" + String(savedCardSyncVersion) +
                   ",\"nvsCardCount\":" + String((unsigned int)syncedLocalCards.size()) +
                   ",\"policyVersion\":" + String(sdnPolicy.version) +
                   ",\"uptimeSec\":" + String(millis() / 1000) +
                   ",\"freeHeapKb\":" + String(ESP.getFreeHeap() / 1024) +
                   ",\"otaStatus\":\"" + otaStatus + "\"}";

  int httpCode = http.POST(payload);
  String resp = "";
  if (httpCode == 200) {
    resp = http.getString();
  }
  http.end();

  if (httpCode != 200 || resp.length() == 0) return;

  // 1. Sinkronisasi Durasi Unlock Default
  defaultUnlockMs = extractNumberField(resp, "unlockDurationMs", defaultUnlockMs);
  if (defaultUnlockMs > MAX_UNLOCK_MS) defaultUnlockMs = MAX_UNLOCK_MS;

  // 2. Sinkronisasi Mode Pintu (HOLD_OPEN / LOCKDOWN / NORMAL)
  if (resp.indexOf("\"mode\":\"HOLD_OPEN\"") >= 0) {
    if (currentMode != "HOLD_OPEN") {
      currentMode = "HOLD_OPEN";
      applyRelayState(true);
      readerBeep(100, 2);
      Serial.println("\n🔥 [MODE] BUKA TERUS (HOLD_OPEN) AKTIF! Magnet dilepas permanen.");
    }
  } else if (resp.indexOf("\"mode\":\"LOCKDOWN\"") >= 0) {
    if (currentMode != "LOCKDOWN") {
      currentMode = "LOCKDOWN";
      applyRelayState(false);
      readerBeep(80, 4);
      Serial.println("\n🚨 [MODE] LOCKDOWN AKTIF! Semua akses ditolak, pintu terkunci total.");
    }
  } else {
    if (currentMode != "NORMAL") {
      currentMode = "NORMAL";
      if (millis() >= unlockTimer) applyRelayState(false);
      readerBeep(100, 1);
      Serial.println("\n✅ [MODE] Mode NORMAL aktif. Auto-lock berfungsi kembali.");
    }
  }

  // 3. Cek Perintah Control Plane dari SDN Controller Web
  if (resp.indexOf("OPEN_ONCE") >= 0 && currentMode != "LOCKDOWN") {
    unsigned long cmdMs = extractNumberField(resp, "durationMs", defaultUnlockMs);
    Serial.printf("\n⚡ [REMOTE WEB] Perintah Buka Pintu 1x (%lu ms)\n", min(cmdMs, MAX_UNLOCK_MS));
    readerBeepSuccess();
    unlockDoor(cmdMs);
  }

  if (resp.indexOf("INSPECT_CODE") >= 0) {
    Serial.println("\n🔎 [SDN CONTROL] Perintah INSPECT_CODE diterima! Mengirim snapshot kode & telemetry...");
    uploadEmbeddedSourceToServer();
    sendFullTelemetryToServer();
  }

  if (resp.indexOf("SYNC_CARDS") >= 0) {
    syncCardsFromServer();
  }

  if (resp.indexOf("REBOOT") >= 0) {
    Serial.println("\n🔄 [SDN CONTROL] Perintah REBOOT diterima! Restarting ESP32...");
    delay(300);
    ESP.restart();
  }

  // 4. Upload source code asli ke Cloud Archive jika server belum memiliki hash ini
  if (extractBoolField(resp, "needSource", false)) {
    uploadEmbeddedSourceToServer();
    sendFullTelemetryToServer();
  }

  // 5. Sinkronisasi SDN Runtime Policy jika policyVersion berubah!
  unsigned long serverPolVer = extractNumberField(resp, "policyVersion", 0);
  if (serverPolVer > 0 && serverPolVer != sdnPolicy.version) {
    syncSdnPolicyFromServer();
  }

  // 6. Sinkronisasi Kartu Offline dari Cloud ke NVS Flash jika versi berubah!
  unsigned long serverCardVer = extractNumberField(resp, "cardSyncVersion", 0);
  if (serverCardVer > 0 && serverCardVer != savedCardSyncVersion) {
    Serial.printf("[CLOUD SYNC] Versi kartu baru (v%lu ➔ v%lu). Mengunduh...\n",
                  savedCardSyncVersion, serverCardVer);
    syncCardsFromServer();
  }

  // 7. Cek Cloud OTA Mass / 1-1 Update!
  bool otaEnabled = extractBoolField(resp, "otaEnabled", false);
  String otaVersion = extractStringField(resp, "otaVersion");
  String otaMd5 = extractStringField(resp, "otaMd5");
  if (otaEnabled && otaVersion.length() > 0 && otaVersion != String(FIRMWARE_VERSION)) {
    performCloudOTA(otaVersion, otaMd5);
  }
}

// =========================================================================
// OPTIMASI WIFI: FULL POWER, NO SLEEP, PILIH AP TERKUAT (BEST RSSI)
// =========================================================================
unsigned long wifiConnectStartedAt = 0;

void applyWiFiMaxPerformance() {
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20);
}

void onWiFiEvent(WiFiEvent_t event) {
  if (event == ARDUINO_EVENT_WIFI_STA_START ||
      event == ARDUINO_EVENT_WIFI_STA_CONNECTED ||
      event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    applyWiFiMaxPerformance();
  }
  if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    Serial.printf("[WIFI] Terhubung! IP: %s | BSSID: %s | Ch: %d | RSSI: %d dBm | TxPower: %d\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.BSSIDstr().c_str(),
                  (int)WiFi.channel(),
                  (int)WiFi.RSSI(),
                  (int)WiFi.getTxPower());
  }
}

void connectStrongestWiFi() {
  wifiConnectStartedAt = millis();
  WiFi.disconnect(true, true);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);
  if (strlen(WIFI_PASS) == 0) {
    WiFi.setMinSecurity(WIFI_AUTH_OPEN);
  }

  Serial.printf("\n[WIFI] Scanning AP untuk SSID '%s'...\n", WIFI_SSID);
  int n = WiFi.scanNetworks(false, false, false, 300);
  int bestIdx = -1;
  int bestRssi = -999;

  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == String(WIFI_SSID)) {
      Serial.printf("  - AP #%d: BSSID=%s | Ch=%d | RSSI=%d dBm\n",
                    i, WiFi.BSSIDstr(i).c_str(), (int)WiFi.channel(i), (int)WiFi.RSSI(i));
      if (WiFi.RSSI(i) > bestRssi) {
        bestRssi = WiFi.RSSI(i);
        bestIdx = i;
      }
    }
  }

  wifiConnectStartedAt = millis();
  if (bestIdx >= 0) {
    Serial.printf("[WIFI] Mengunci AP TERKUAT: BSSID=%s | Ch=%d | %d dBm\n",
                  WiFi.BSSIDstr(bestIdx).c_str(), (int)WiFi.channel(bestIdx), bestRssi);
    if (strlen(WIFI_PASS) > 0) {
      WiFi.begin(WIFI_SSID, WIFI_PASS, WiFi.channel(bestIdx), WiFi.BSSID(bestIdx));
    } else {
      WiFi.begin(WIFI_SSID, nullptr, WiFi.channel(bestIdx), WiFi.BSSID(bestIdx));
    }
  } else {
    if (strlen(WIFI_PASS) > 0) {
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    } else {
      WiFi.begin(WIFI_SSID);
    }
  }
  WiFi.scanDelete();
  applyWiFiMaxPerformance();
}

void setup() {
  pinMode(PIN_RELAY, OUTPUT);
  applyRelayState(false);

  Serial.begin(115200);
  delay(400);

  pinMode(PIN_BEEP, OUTPUT);
  digitalWrite(PIN_BEEP, HIGH);
  pinMode(PIN_LED, OUTPUT);
  readerLed(false);
  pinMode(PIN_EXIT, INPUT_PULLUP);

  pinMode(PIN_D0, INPUT_PULLUP);
  pinMode(PIN_D1, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_D0), isrD0, FALLING);
  attachInterrupt(digitalPinToInterrupt(PIN_D1), isrD1, FALLING);

  btStop();
#if defined(CONFIG_IDF_TARGET_ESP32)
  esp_bt_controller_mem_release(ESP_BT_MODE_BTDM);
#elif defined(CONFIG_IDF_TARGET_ESP32S3)
  esp_bt_controller_mem_release(ESP_BT_MODE_BLE);
#endif

  loadOfflineCardsFromNVS();
  loadSdnPolicyFromNVS();

  esp_task_wdt_config_t twdt_config = {
    .timeout_ms = 15000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  if (esp_task_wdt_init(&twdt_config) == ESP_ERR_INVALID_STATE) {
    esp_task_wdt_reconfigure(&twdt_config);
  }
  esp_task_wdt_add(NULL);

  WiFi.onEvent(onWiFiEvent);
  connectStrongestWiFi();

  Serial.println("\n========================================================");
  Serial.printf("  ESP32 ACCESS DOOR v%s [SDN HASH: #%s]\n", FIRMWARE_VERSION, FIRMWARE_CODE_HASH);
  Serial.println("========================================================");
  Serial.println("  SDN Control Plane: Embedded Source Code Inspection,");
  Serial.println("  Runtime Policy Sync, Cloud OTA, NVS Card Sync, Anti-BF");
  Serial.println("========================================================\n");

  readerBeep(80, 1);
}

void loop() {
  esp_task_wdt_reset();
  unsigned long now = millis();

  // 1. Cek Tombol Exit Dalam
  if (digitalRead(PIN_EXIT) == LOW) {
    if (now - lastExitButtonPress > 1500) {
      lastExitButtonPress = now;
      if (currentMode == "LOCKDOWN" && !sdnPolicy.exitInLockdown) {
        Serial.println("\n[EXIT BUTTON] Ditolak karena mode LOCKDOWN!");
        readerBeep(80, 3);
        sendExitButtonEvent();
      } else if (currentMode == "HOLD_OPEN") {
        Serial.println("\n[EXIT BUTTON] Pintu sudah dalam mode BUKA TERUS.");
        readerBeep(100, 1);
      } else {
        Serial.println("\n[EXIT BUTTON] Tombol keluar ditekan! Membuka pintu...");
        readerBeepSuccess();
        unlockDoor(defaultUnlockMs);
        sendExitButtonEvent();
      }
    }
  }

  // 2. Cek Pembacaan Kartu Wiegand (D0 & D1)
  if (bitCount > 0 && (now - lastBitTime > 30)) {
    noInterrupts();
    unsigned long raw = cardData;
    int count = bitCount;
    bitCount = 0;
    cardData = 0;
    interrupts();

    if (count == 26 || count == 34 || count == 32) {
      unsigned long cardUid = 0;
      if (count == 26) {
        cardUid = (raw >> 1) & 0xFFFFFF;
      } else if (count == 34) {
        cardUid = (raw >> 1) & 0xFFFFFFFF;
      } else {
        cardUid = raw;
      }

      // A. Anti-Spam Kartu Sama
      if (cardUid == lastTappedUid && (now - lastTappedTime < sdnPolicy.sameCardCooldownMs)) {
        Serial.printf("[ANTI-SPAM] Abaikan tap ganda kartu %lu.\n", cardUid);
        return;
      }

      // B. Anti-Bruteforce Lockout
      if (sdnPolicy.antiBruteforce && now < lockoutUntil) {
        unsigned long remSec = (lockoutUntil - now + 999) / 1000;
        Serial.printf("🔒 [LOCKOUT AKTIF] Reader terkunci %lu detik lagi! Abaikan kartu %lu.\n", remSec, cardUid);
        if (now - lastLockoutBeep > 1200) {
          lastLockoutBeep = now;
          readerBeep(180, 1);
        }
        return;
      }

      // C. Cooldown Pasca Salah Kartu
      if (sdnPolicy.antiBruteforce && now < tapCooldownUntil) {
        Serial.printf("⏳ [COOLDOWN] Tunggu sebentar sebelum tap ulang! Abaikan kartu %lu.\n", cardUid);
        return;
      }

      lastTappedUid = cardUid;
      lastTappedTime = now;

      Serial.println("\n==============================================");
      Serial.printf(" [KARTU DITAP] UID: %lu (HEX: 0x%08lX)\n", cardUid, cardUid);
      Serial.printf(" Mode: %s | FW: v%s (#%s)\n", currentMode.c_str(), FIRMWARE_VERSION, FIRMWARE_CODE_HASH);
      Serial.println("==============================================");

      if (currentMode == "LOCKDOWN") {
        Serial.println("[AKSES DITOLAK] Sistem dalam mode LOCKDOWN!");
        readerBeep(80, 4);
        sendCardTapToServer(cardUid, false);
      } else if (currentMode == "HOLD_OPEN") {
        Serial.println("[INFO] Pintu sudah dalam mode BUKA TERUS.");
        readerBeep(100, 1);
        sendCardTapToServer(cardUid, false);
      } else {
        bool verifiedOnline = sendCardTapToServer(cardUid, true);

        if (!verifiedOnline) {
          Serial.println("[FAILOVER NVS LOKAL] Memeriksa daftar kartu lokal tersinkron...");
          unsigned long customOfflineMs = 0;
          if (isAuthorizedOffline(cardUid, customOfflineMs)) {
            resetFailedAttempts();
            unsigned long openMs = (customOfflineMs > 0) ? customOfflineMs : defaultUnlockMs;
            Serial.printf(" [AKSES DITERIMA - LOKAL COCOK!] UID: %lu (%lu ms)\n", cardUid, openMs);
            unlockDoor(openMs);
            readerBeepCardTail();
          } else {
            Serial.printf(" [AKSES DITOLAK - TIDAK ADA DI NVS LOKAL!] UID: %lu\n", cardUid);
            registerFailedAttempt(cardUid);
          }
        }
      }
    }
  }

  // 3. Pengaturan Logika Auto-Lock Relay Sesuai Mode
  if (currentMode == "NORMAL") {
    if (isRelayUnlocked && now >= unlockTimer) {
      applyRelayState(false);
      Serial.println("[RELAY] Waktu habis, pintu terkunci kembali (Auto-Lock).\n");
    }
  } else if (currentMode == "HOLD_OPEN") {
    if (!isRelayUnlocked) applyRelayState(true);
  } else if (currentMode == "LOCKDOWN") {
    if (isRelayUnlocked) applyRelayState(false);
  }

  // 4. Heartbeat, SDN Policy, Sync Kartu & Cloud OTA
  if (now - lastHeartbeat >= sdnPolicy.heartbeatIntervalMs) {
    lastHeartbeat = now;
    sendHeartbeat();
  }

  // 5. Pantau Kesehatan WiFi
  if (WiFi.status() != WL_CONNECTED) {
    if (now - wifiConnectStartedAt >= 15000) {
      Serial.println("[WIFI] Belum tersambung >15s, scan ulang mencari AP terkuat...");
      connectStrongestWiFi();
    }
  }
}
