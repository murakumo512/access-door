# Centralized Access Door System (ESP32 CP2102/S3 + Web Dashboard + Android/iOS App)

Sistem kontrol akses pintu terpusat (**Centralized Access Door**) berbasis **ESP32 / ESP32-S3**, **Wiegand RFID Reader**, **EM Lock 280kg (Fail-Safe)**, **Web Dashboard Node.js (Docker / Portainer)**, dan **Aplikasi Mobile Android & iOS (Expo React Native)**.

## Struktur Folder

- `web-server/` — Backend API (`server.js`), Web Dashboard (`public/index.html` + schematic Full WAGO & panduan PCB Double Layer + Export PNG/SVG), `Dockerfile`, `docker-compose.yml` (Docker biasa tanpa Portainer), dan `docker-compose.swarm.yml` (Docker Swarm / Portainer).
- `esp32-firmware/` — Firmware PlatformIO **`v2.1.9`** (`src/main.cpp`, `platformio.ini`, `embed_source.py`) untuk `esp32dev` (CP2102) & `esp32s3` (ESP32-S3).
- `mobile-app/` — Aplikasi mobile **React Native Expo `v1.1.0`** (Live Face Unlock, Kontrol Pintu + Biometrik HP, Face DB, Kartu RFID, Log, SDN Policy, Site & User).
- `docs/` — Dokumentasi teknis lengkap (`DOKUMENTASI_LENGKAP.md`, `DOKUMENTASI_SISTEM.md`), schematic standalone (`schematic_cp2102_vs_s3.html`), serta panduan GitHub & Docker (`DEPLOYMENT_DOCKER_DAN_PORTAINER.md`).

> Lihat panduan lengkap cara push ke GitHub dan cara deploy Docker (tanpa Portainer maupun pakai Portainer) di [`docs/DEPLOYMENT_DOCKER_DAN_PORTAINER.md`](./docs/DEPLOYMENT_DOCKER_DAN_PORTAINER.md).
