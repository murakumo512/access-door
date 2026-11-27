# Dokumentasi Teknis Lengkap: Centralized Access Door (ESP32 SDN + Web Control Plane + Face ID)

- **URL Live**: `https://access-door.example.com` (`http://192.168.1.100:3000`)
- **Firmware ESP32**: `esp32-firmware/src/main.cpp` (`v2.1.4`, mendukung `esp32dev` CP2102 & `esp32s3`)
- **Backend Server**: `server.js`
- **Frontend UI**: `public/index.html`

## Ringkasan Perbedaan Schematic ESP32 CP2102 vs ESP32-S3
1. **Shield DT-Y6593 (30/38-pin)** hanya muat di **ESP32 CP2102**, tidak bisa langsung dicolok ke **ESP32-S3 DevKitC-1 (44-pin)**.
2. **Pin yang Berubah di ESP32-S3**:
   - `PIN_RELAY`: `GPIO 4` (sama)
   - `PIN_D0`: `GPIO 5` (di CP2102: `GPIO 18`)
   - `PIN_D1`: `GPIO 6` (di CP2102: `GPIO 19` — di S3 GPIO 19/20 adalah USB Native!)
   - `PIN_BEEP`: `GPIO 7` (di CP2102: `GPIO 23` — GPIO 23 tidak ada di S3!)
   - `PIN_EXIT`: `GPIO 15` (di CP2102: `GPIO 27` — GPIO 27 tidak ada di S3!)
3. **Environment Build PlatformIO**:
   - `pio run -e esp32dev` -> `.pio/build/esp32dev/firmware.bin`
   - `pio run -e esp32s3` -> `.pio/build/esp32s3/firmware.bin`
