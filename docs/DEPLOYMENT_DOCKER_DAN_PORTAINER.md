# Panduan Push ke GitHub & Deploy Docker (Tanpa Portainer vs Pakai Portainer)

---

## 1. Cara Push Backup ke Repo GitHub

### Langkah A: Buat Repository Baru di GitHub
1. Buka **https://github.com/new**
2. Isi **Repository name** (misal: `centralized-access-door`)
3. Pilih **Public** (jika pakai folder `access-door-github-public`) atau **Private** (jika pakai folder `access-door-github`)
4. **Jangan** centang *Add a README file* atau *.gitignore* (karena sudah kita siapkan di folder lokal)
5. Klik **Create repository**

### Langkah B: Push dari Terminal Mac
```bash
# Untuk repo PUBLIC (kredensial sudah disensor aman):
cd ~/Documents/access-door-github-public

# (Atau untuk repo PRIVATE dengan konfigurasi lengkap):
# cd ~/Documents/access-door-github

git init
git branch -M main
git add .
git commit -m "Backup lengkap: Web Dashboard, ESP32 v2.1.9, Mobile App v1.1.0 & Docs"
git remote add origin https://github.com/<USERNAME-KAMU>/<NAMA-REPO>.git
git push -u origin main
```
*(Jika diminta password saat `git push`, masukkan **Personal Access Token (PAT)** GitHub kamu, bukan password login web GitHub.)*

---

## 2. Deploy di Docker TANPA Portainer (Docker Compose Biasa)

Cocok untuk VPS / Ubuntu Server / Mini PC / Mac biasa yang hanya memakai Docker Engine + Docker Compose.

### Cara 1: Pakai `docker compose` (Paling Mudah & Direkomendasikan)
```bash
# 1. Clone repo dari GitHub di server
git clone https://github.com/<USERNAME-KAMU>/<NAMA-REPO>.git
cd <NAMA-REPO>/web-server

# 2. (Opsional tapi disarankan) Buat file .env
cp .env.example .env 2>/dev/null || true
nano .env
# Isi:
# ADMIN_PASSWORD=password_kuat_kamu
# DEVICE_API_KEY=api_key_esp32_kamu

# 3. Build image & jalankan di background
docker compose up -d --build

# 4. Cek log & status container
docker compose ps
docker compose logs -f access-door-web
```

### Cara 2: Pakai `docker build` & `docker run` Manual (Tanpa Compose)
```bash
cd <NAMA-REPO>/web-server

# Build image lokal
docker build -t access-door-web:latest .

# Jalankan container dengan volume persisten (/app/data)
docker run -d \
  --name access-door-web \
  --restart unless-stopped \
  -p 3000:3000 \
  -e PORT=3000 \
  -e ADMIN_PASSWORD="password_kuat_kamu" \
  -e DEVICE_API_KEY="api_key_esp32_kamu" \
  -e DATA_DIR="/app/data" \
  -e TZ="Asia/Jakarta" \
  -v access_door_data:/app/data \
  access-door-web:latest
```

### Cara Update Jika Ada Perubahan Kode (Tanpa Portainer)
```bash
cd <NAMA-REPO>/web-server
git pull
docker compose up -d --build
```

---

## 3. Deploy Pakai Portainer (Docker Swarm / Stack)

Ada **2 cara** di Portainer:

### Opsi A: Portainer Stack via Git Repository (Paling Bersih)
1. Buka **Portainer** ➔ pilih Environment ➔ **Stacks** ➔ **+ Add stack**.
2. Isi Name: `access-door`.
3. Pada **Build method**, pilih **Repository**.
4. Masukkan **Repository URL**: `https://github.com/<USERNAME-KAMU>/<NAMA-REPO>`
5. **Repository reference**: `refs/heads/main`
6. **Compose path**: `web-server/docker-compose.swarm.yml` *(atau `web-server/docker-compose.yml` jika non-Swarm)*.
7. Tambahkan **Environment variables** (`ADMIN_PASSWORD`, `DEVICE_API_KEY`), lalu klik **Deploy the stack**.
8. Untuk update nanti, cukup klik stack ➔ **Pull and redeploy**.

### Opsi B: Portainer Web Editor (Zero-Build / Langsung Jalan dari `APP_BUNDLE`)
Cocok untuk **Docker Swarm multi-node** tanpa perlu build image di tiap node (cukup image `node:20-alpine`):
1. Buka **Portainer** ➔ **Stacks** ➔ **+ Add stack** ➔ pilih **Web editor**.
2. Copy seluruh isi file `web-server/portainer-web-editor.yml` (tersedia di backup private) lalu paste ke Web Editor.
3. Klik **Deploy the stack**.
