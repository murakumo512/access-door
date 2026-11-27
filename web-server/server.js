const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CHANGE_ME_ADMIN_PASSWORD';
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || 'CHANGE_ME_DEVICE_API_KEY';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const FIRMWARE_DIR = path.join(DATA_DIR, 'firmware');
const FIRMWARE_BIN_FILE = path.join(FIRMWARE_DIR, 'latest.bin');
const FIRMWARE_META_FILE = path.join(FIRMWARE_DIR, 'meta.json');
const SOURCES_DIR = path.join(DATA_DIR, 'sources');
const FACES_FILE = path.join(DATA_DIR, 'faces.json');

app.use('/api/device/source-upload', express.text({ type: 'text/plain', limit: '512kb' }));
app.use(express.json({ limit: '6mb' }));

// Cache & pre-gzip index.html in RAM for instant (<1ms) first paint
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
let cachedIndexRaw = null;
let cachedIndexGzip = null;
let cachedIndexEtag = null;

function loadCachedIndex() {
  try {
    const buf = fs.readFileSync(INDEX_HTML_PATH);
    cachedIndexRaw = buf;
    cachedIndexGzip = zlib.gzipSync(buf, { level: 6 });
    cachedIndexEtag = `"${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}"`;
  } catch (err) {
    console.error('Failed caching index.html:', err.message);
  }
}
loadCachedIndex();

function sendIndexHtml(req, res) {
  if (!cachedIndexRaw) loadCachedIndex();
  if (!cachedIndexRaw) return res.status(404).send('Not Found');

  if (cachedIndexEtag && req.headers['if-none-match'] === cachedIndexEtag) {
    return res.status(304).end();
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Vary', 'Accept-Encoding');
  if (cachedIndexEtag) res.setHeader('ETag', cachedIndexEtag);

  const acceptEnc = String(req.headers['accept-encoding'] || '');
  if (acceptEnc.includes('gzip') && cachedIndexGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.send(cachedIndexGzip);
  }
  return res.send(cachedIndexRaw);
}

app.get(['/', '/index.html'], sendIndexHtml);
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default Persistent Database Structure (Multi-Site + Multi-Role RBAC)
const defaultDb = {
  sites: {
    'site-pusat': {
      id: 'site-pusat',
      name: 'Site Pusat (Head Office)',
      address: 'Gedung Utama',
      createdAt: new Date().toISOString()
    },
    'site-cabang': {
      id: 'site-cabang',
      name: 'Site Cabang / Gudang',
      address: 'Area Operasional',
      createdAt: new Date().toISOString()
    }
  },
  admins: [
    {
      username: 'admin',
      password: ADMIN_PASSWORD,
      name: 'Super Admin Utama',
      role: 'SUPER_ADMIN',     // SUPER_ADMIN | SITE_ADMIN | VIEWER
      accessMode: 'READ_WRITE', // READ_WRITE | READ_ONLY
      allowedSites: ['*'],      // ['*'] = Semua Site, atau ['site-pusat']
      createdAt: new Date().toISOString()
    },
    {
      username: 'admin-pusat',
      password: 'CHANGE_ME_SITE_PASSWORD',
      name: 'Admin Site Pusat',
      role: 'SITE_ADMIN',
      accessMode: 'READ_WRITE',
      allowedSites: ['site-pusat'],
      createdAt: new Date().toISOString()
    },
    {
      username: 'viewer',
      password: 'CHANGE_ME_VIEWER_PASSWORD',
      name: 'Petugas Monitoring (Read-Only)',
      role: 'VIEWER',
      accessMode: 'READ_ONLY',
      allowedSites: ['*'],
      createdAt: new Date().toISOString()
    }
  ],
  doors: {
    'pintu-utama': {
      id: 'pintu-utama',
      name: 'Pintu Utama Office',
      siteId: 'site-pusat',
      location: 'Lantai 1 - Lobby',
      mode: 'NORMAL', // NORMAL | HOLD_OPEN | LOCKDOWN
      unlockDurationMs: 5000,
      lastSeen: 0,
      ip: '-',
      rssi: 0,
      isRelayUnlocked: false,
      unlockedUntil: 0,
      isPhysicallyOpen: false,
      holdOpenKeepAjar: false,
      doorAjarWarning: false,
      lastActorName: '-',
      lastCardUid: '-',
      pendingCommand: null
    }
  },
  cards: [
    {
      uid: '12345678',
      name: 'Budi Santoso (Contoh)',
      role: 'IT / Admin',
      allowedDoors: ['*'],
      active: true,
      createdAt: new Date().toISOString()
    }
  ],
  logs: [],
  cardSyncVersion: 1
};

const defaultSdnPolicy = {
  version: 1,
  antiBruteforce: true,
  bruteforceMaxFails: 3,
  lockoutDurationSec: 15,
  sameCardCooldownMs: 2000,
  exitInLockdown: false,
  buzzerEnabled: true,
  heartbeatIntervalMs: 2500
};

let db = defaultDb;
let otaMeta = {
  enabled: false,
  version: '',
  md5: '',
  sha256: '',
  size: 0,
  notes: '',
  targetMode: 'ALL', // ALL | SELECTED
  targetDoors: [],
  uploadedAt: null
};
const doorTimers = {};
const sessions = new Map(); // token -> { username, createdAt }

if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
}
if (!fs.existsSync(SOURCES_DIR)) {
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
}

function getSourceFilePath(codeHash) {
  const safe = String(codeHash || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return safe ? path.join(SOURCES_DIR, `${safe}.cpp`) : null;
}

function hasSourceCode(codeHash) {
  const p = getSourceFilePath(codeHash);
  return Boolean(p && fs.existsSync(p));
}

function loadOtaMeta() {
  try {
    if (fs.existsSync(FIRMWARE_META_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FIRMWARE_META_FILE, 'utf-8'));
      otaMeta = {
        enabled: Boolean(parsed.enabled),
        version: String(parsed.version || ''),
        md5: String(parsed.md5 || ''),
        sha256: String(parsed.sha256 || ''),
        size: Number(parsed.size) || 0,
        notes: String(parsed.notes || ''),
        targetMode: parsed.targetMode === 'SELECTED' ? 'SELECTED' : 'ALL',
        targetDoors: Array.isArray(parsed.targetDoors) ? parsed.targetDoors : [],
        uploadedAt: parsed.uploadedAt || null
      };
    }
  } catch (err) {
    console.error('Error loading OTA meta:', err.message);
  }
}

function saveOtaMeta() {
  try {
    if (!fs.existsSync(FIRMWARE_DIR)) fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
    fs.writeFileSync(FIRMWARE_META_FILE, JSON.stringify(otaMeta, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving OTA meta:', err.message);
  }
}

function bumpCardSyncVersion(targetDoorIds = null) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (Array.isArray(targetDoorIds) && targetDoorIds.length > 0) {
    for (const dId of targetDoorIds) {
      const door = db.doors[dId];
      if (door) {
        const prev = Number(door.desiredCardSyncVersion) || Number(db.cardSyncVersion) || 1;
        door.desiredCardSyncVersion = Math.max(prev + 1, nowSec);
      }
    }
    return;
  }

  db.cardSyncVersion = Math.max((Number(db.cardSyncVersion) || 1) + 1, nowSec);
  for (const door of Object.values(db.doors)) {
    const prev = Number(door.desiredCardSyncVersion) || 1;
    door.desiredCardSyncVersion = Math.max(db.cardSyncVersion, prev + 1);
  }
}

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      db = {
        sites: parsed.sites && Object.keys(parsed.sites).length ? parsed.sites : defaultDb.sites,
        admins: Array.isArray(parsed.admins) && parsed.admins.length ? parsed.admins : defaultDb.admins,
        doors: parsed.doors || defaultDb.doors,
        cards: (parsed.cards || defaultDb.cards).map((c) => ({
          ...c,
          allowedDoors: Array.isArray(c.allowedDoors) && c.allowedDoors.length ? c.allowedDoors : ['*'],
          offlineSync: c.offlineSync !== false,
          unlockDurationMs: Number(c.unlockDurationMs) || 0
        })),
        logs: parsed.logs || [],
        cardSyncVersion: Number(parsed.cardSyncVersion) || 1,
        sdnStandardPolicy: { ...defaultSdnPolicy, ...(parsed.sdnStandardPolicy || {}) }
      };

      // Pastikan selalu ada minimal 1 SUPER_ADMIN ('admin')
      const superAdmin = db.admins.find((a) => a.username === 'admin' || a.role === 'SUPER_ADMIN');
      if (!superAdmin) {
        db.admins.unshift(defaultDb.admins[0]);
      } else if (superAdmin.username === 'admin' && process.env.ADMIN_PASSWORD) {
        superAdmin.password = process.env.ADMIN_PASSWORD;
      }

      const firstSiteId = Object.keys(db.sites)[0] || 'site-pusat';
      for (const door of Object.values(db.doors)) {
        door.siteId = door.siteId && db.sites[door.siteId] ? door.siteId : firstSiteId;
        door.isRelayUnlocked = Boolean(door.isRelayUnlocked);
        door.unlockedUntil = Number(door.unlockedUntil) || 0;
        door.isPhysicallyOpen = Boolean(door.isPhysicallyOpen);
        door.holdOpenKeepAjar = Boolean(door.holdOpenKeepAjar);
        door.doorAjarWarning = Boolean(door.doorAjarWarning);
        door.lastActorName = door.lastActorName || '-';
        door.lastCardUid = door.lastCardUid || '-';
        door.firmwareVersion = door.firmwareVersion || '-';
        door.boardType = door.boardType || 'ESP32_CP2102';
        door.chipModel = door.chipModel || 'ESP32';
        door.codeHash = door.codeHash || '-';
        door.cardSyncVersion = Number(door.cardSyncVersion) || 0;
        door.desiredCardSyncVersion = Number(door.desiredCardSyncVersion) || Number(db.cardSyncVersion) || 1;
        door.otaStatus = door.otaStatus || 'IDLE';
        door.sdnPolicy = { ...defaultSdnPolicy, ...(door.sdnPolicy || {}) };
        door.policyVersion = Number(door.policyVersion) || 0;
        door.nvsCardCount = Number(door.nvsCardCount) || 0;
        door.uptimeSec = Number(door.uptimeSec) || 0;
        door.freeHeapKb = Number(door.freeHeapKb) || 0;
        door.bssid = door.bssid || '-';
        door.channel = Number(door.channel) || 0;
        door.txPower = Number(door.txPower) || 0;
        door.telemetry = door.telemetry || null;
      }
    } else {
      saveDb();
    }
  } catch (err) {
    console.error('Error loading DB, using default:', err.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving DB:', err.message);
  }
}

let facesDb = [];

function sanitizeFaceRules(rawRules) {
  const out = {};
  if (rawRules && typeof rawRules === 'object') {
    for (const [dId, val] of Object.entries(rawRules)) {
      const upper = String(val || '').toUpperCase();
      if (upper === 'PERMIT' || upper === 'DENY') {
        out[String(dId).trim()] = upper;
      }
    }
  }
  return out;
}

function loadFacesDb() {
  try {
    if (fs.existsSync(FACES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FACES_FILE, 'utf-8'));
      if (Array.isArray(parsed)) {
        facesDb = parsed
          .filter((f) => f && f.id && f.name && Array.isArray(f.embedding) && f.embedding.length === 128)
          .map((f) => ({
            id: String(f.id),
            name: String(f.name).trim(),
            role: String(f.role || 'Staff').trim(),
            active: f.active !== false,
            defaultPolicy: String(f.defaultPolicy || 'DENY').toUpperCase() === 'PERMIT' ? 'PERMIT' : 'DENY',
            doorRules: sanitizeFaceRules(f.doorRules),
            photoBase64: String(f.photoBase64 || ''),
            embedding: f.embedding.map(Number),
            createdAt: f.createdAt || new Date().toISOString(),
            updatedAt: f.updatedAt || f.createdAt || new Date().toISOString()
          }));
      }
    } else {
      saveFacesDb();
    }
  } catch (err) {
    console.error('Error loading faces DB:', err.message);
    facesDb = [];
  }
}

function saveFacesDb() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FACES_FILE, JSON.stringify(facesDb, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving faces DB:', err.message);
  }
}

function sanitizeFaceForClient(face) {
  return {
    id: face.id,
    name: face.name,
    role: face.role || 'Staff',
    active: face.active !== false,
    defaultPolicy: face.defaultPolicy === 'PERMIT' ? 'PERMIT' : 'DENY',
    doorRules: face.doorRules || {},
    photoBase64: face.photoBase64 || '',
    hasEmbedding: Array.isArray(face.embedding) && face.embedding.length === 128,
    createdAt: face.createdAt,
    updatedAt: face.updatedAt
  };
}

function getFaceDoorPermission(face, doorId) {
  const rule = face?.doorRules?.[doorId];
  if (rule === 'PERMIT' || rule === 'DENY') return rule;
  return face?.defaultPolicy === 'PERMIT' ? 'PERMIT' : 'DENY';
}

loadDb();
loadOtaMeta();
loadFacesDb();

// ============================================================================
// HELPER ROLE, SITE & PERMISSION
// ============================================================================

function sanitizeUser(admin) {
  if (!admin) return null;
  const isReadOnly = admin.accessMode === 'READ_ONLY' || admin.role === 'VIEWER';
  return {
    username: admin.username,
    name: admin.name,
    role: admin.role, // SUPER_ADMIN | SITE_ADMIN | VIEWER
    accessMode: isReadOnly ? 'READ_ONLY' : 'READ_WRITE',
    allowedSites: admin.role === 'SUPER_ADMIN' ? ['*'] : (Array.isArray(admin.allowedSites) ? admin.allowedSites : ['*'])
  };
}

function isSuperAdmin(user) {
  return Boolean(user && user.role === 'SUPER_ADMIN');
}

function isReadOnlyUser(user) {
  return Boolean(!user || user.accessMode === 'READ_ONLY' || user.role === 'VIEWER');
}

function canUserAccessSite(user, siteId) {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  const allowed = Array.isArray(user.allowedSites) ? user.allowedSites : [];
  return allowed.includes('*') || allowed.includes(siteId);
}

function canUserAccessDoor(user, door) {
  if (!user || !door) return false;
  return canUserAccessSite(user, door.siteId || 'site-pusat');
}

function getDoorsWithOnlineStatus(user = null) {
  const now = Date.now();
  const result = {};
  for (const [id, door] of Object.entries(db.doors)) {
    if (user && !canUserAccessDoor(user, door)) continue;
    const isTimerUnlocked = (door.unlockedUntil || 0) > now;
    const remainingSec = isTimerUnlocked ? Math.ceil((door.unlockedUntil - now) / 1000) : 0;
    const siteObj = db.sites[door.siteId] || { id: door.siteId, name: door.siteId };
    result[id] = {
      ...door,
      siteName: siteObj.name,
      hasSourceCode: hasSourceCode(door.codeHash),
      isRelayUnlocked: Boolean(door.isRelayUnlocked || isTimerUnlocked || door.mode === 'HOLD_OPEN'),
      remainingSec,
      online: now - (door.lastSeen || 0) < 10000
    };
  }
  return result;
}

function getVisibleSitesForUser(user) {
  const result = {};
  for (const [id, site] of Object.entries(db.sites)) {
    if (canUserAccessSite(user, id)) {
      result[id] = site;
    }
  }
  return result;
}

function getVisibleLogsForUser(user) {
  return db.logs
    .filter((log) => {
      const door = db.doors[log.doorId];
      const siteId = log.siteId || door?.siteId || 'site-pusat';
      return canUserAccessSite(user, siteId);
    })
    .slice(0, 150);
}

function buildStatePayloadForUser(user) {
  const visibleDoors = getDoorsWithOnlineStatus(user);
  const visibleDoorIds = new Set(Object.keys(visibleDoors));

  const visibleCards = db.cards.filter((c) => {
    if (isSuperAdmin(user) || (user.allowedSites && user.allowedSites.includes('*'))) return true;
    const allowed = Array.isArray(c.allowedDoors) ? c.allowedDoors : ['*'];
    return allowed.includes('*') || allowed.some((dId) => visibleDoorIds.has(dId));
  });

  return {
    type: 'STATE_UPDATE',
    currentUser: sanitizeUser(user),
    sites: getVisibleSitesForUser(user),
    doors: visibleDoors,
    logs: getVisibleLogsForUser(user),
    cards: visibleCards,
    admins: isSuperAdmin(user) ? db.admins.map(sanitizeUser) : [],
    deviceApiKey: isSuperAdmin(user) ? DEVICE_API_KEY : '(Hanya Super Admin)',
    ota: otaMeta,
    cardSyncVersion: db.cardSyncVersion,
    sdnStandardPolicy: db.sdnStandardPolicy || defaultSdnPolicy,
    faces: facesDb.map(sanitizeFaceForClient),
    serverNow: Date.now()
  };
}

// ============================================================================
// REALTIME SSE CLIENTS (Per-User Filtering)
// ============================================================================
const sseClients = new Map(); // res -> user

function safeSseWrite(res, chunk) {
  if (res.writableEnded || res.destroyed) {
    sseClients.delete(res);
    return;
  }
  try {
    res.write(chunk);
  } catch (_) {
    sseClients.delete(res);
  }
}

function broadcastEvent(eventPayload, targetSiteId = null) {
  const line = `data: ${JSON.stringify(eventPayload)}\n\n`;
  for (const [res, user] of sseClients.entries()) {
    if (targetSiteId && !canUserAccessSite(user, targetSiteId)) continue;
    safeSseWrite(res, line);
  }
}

function broadcastUpdate() {
  for (const [res, user] of sseClients.entries()) {
    const freshAdmin = db.admins.find((a) => a.username === user.username) || user;
    const payload = buildStatePayloadForUser(freshAdmin);
    safeSseWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
  }
}

function addLog({ doorId, doorName, siteId, siteName, eventType, status, actorName, cardUid, details }) {
  const door = db.doors[doorId];
  const resolvedSiteId = siteId || door?.siteId || 'site-pusat';
  const resolvedSiteName = siteName || db.sites[resolvedSiteId]?.name || resolvedSiteId;

  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    doorId: doorId || 'pintu-utama',
    doorName: doorName || (door?.name || doorId),
    siteId: resolvedSiteId,
    siteName: resolvedSiteName,
    eventType, // 'RFID_IN' | 'EXIT_BUTTON' | 'REMOTE_OPEN' | 'REMOTE_MODE' | 'DOOR_STATE'
    status,    // 'GRANTED' | 'DENIED' | 'WARN' | 'INFO'
    actorName: actorName || '-',
    cardUid: cardUid || '-',
    details: details || ''
  };
  db.logs.unshift(entry);
  if (db.logs.length > 1000) {
    db.logs = db.logs.slice(0, 1000);
  }
  saveDb();
  broadcastUpdate();
  return entry;
}

function triggerServerUnlockState(door, durationMs, actorName = '-', cardUid = '-') {
  const openMs = Number(durationMs) || door.unlockDurationMs || 5000;
  const openSec = Math.round(openMs / 1000);

  if (doorTimers[door.id]) {
    clearTimeout(doorTimers[door.id]);
  }

  door.unlockedUntil = Date.now() + openMs;
  door.isRelayUnlocked = true;
  door.isPhysicallyOpen = true;
  door.doorAjarWarning = false;
  door.lastActorName = actorName || door.lastActorName || '-';
  door.lastCardUid = cardUid || door.lastCardUid || '-';

  saveDb();
  broadcastUpdate();

  doorTimers[door.id] = setTimeout(() => {
    if (door.mode === 'HOLD_OPEN') return;

    door.unlockedUntil = 0;

    if (door.holdOpenKeepAjar) {
      door.isRelayUnlocked = false;
      door.isPhysicallyOpen = true;
      door.doorAjarWarning = true;

      addLog({
        doorId: door.id,
        doorName: door.name,
        siteId: door.siteId,
        eventType: 'DOOR_STATE',
        status: 'WARN',
        actorName: door.lastActorName || 'Sensor Pintu',
        cardUid: door.lastCardUid || '-',
        details: `Peringatan: countdown ${openSec} detik habis, pintu belum ditutup (akses oleh ${door.lastActorName}).`
      });
    } else {
      door.isRelayUnlocked = false;
      door.isPhysicallyOpen = false;
      door.doorAjarWarning = false;

      addLog({
        doorId: door.id,
        doorName: door.name,
        siteId: door.siteId,
        eventType: 'DOOR_STATE',
        status: 'INFO',
        actorName: door.lastActorName || 'Sistem Auto-Lock',
        cardUid: door.lastCardUid || '-',
        details: `Countdown ${openSec} detik selesai — pintu tertutup & EM lock terkunci kembali.`
      });
    }
  }, openMs);
}

function markDoorPhysicallyClosed(door) {
  if (doorTimers[door.id]) {
    clearTimeout(doorTimers[door.id]);
    delete doorTimers[door.id];
  }

  const wasOpenOrWarn = door.isPhysicallyOpen || door.doorAjarWarning || door.isRelayUnlocked;
  door.isPhysicallyOpen = false;
  door.holdOpenKeepAjar = false;
  door.doorAjarWarning = false;
  door.unlockedUntil = 0;
  if (door.mode !== 'HOLD_OPEN') {
    door.isRelayUnlocked = false;
  }

  if (wasOpenOrWarn) {
    addLog({
      doorId: door.id,
      doorName: door.name,
      siteId: door.siteId,
      eventType: 'DOOR_STATE',
      status: 'INFO',
      actorName: door.lastActorName || 'Sensor Pintu',
      cardUid: door.lastCardUid || '-',
      details: 'Pintu tertutup rapat & EM lock terkunci kembali.'
    });
  } else {
    saveDb();
    broadcastUpdate();
  }
}

// ============================================================================
// AUTH MIDDLEWARES
// ============================================================================

function resolveUserFromRequest(req) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token && sessions.has(token)) {
    const sess = sessions.get(token);
    const found = db.admins.find((a) => a.username === sess.username);
    if (found) return found;
  }

  // Fallback kompatibilitas x-admin-password
  const legacyPw = req.headers['x-admin-password'] || req.query.adminPassword;
  if (legacyPw) {
    const foundByPw = db.admins.find((a) => a.password === legacyPw);
    if (foundByPw) return foundByPw;
  }
  return null;
}

function requireAdmin(req, res, next) {
  const user = resolveUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Sesi berakhir atau belum login.' });
  }
  req.user = user;
  next();
}

function requireWriteAccess(req, res, next) {
  if (isReadOnlyUser(req.user)) {
    return res.status(403).json({
      error: 'Akses Ditolak: Akun Anda berada dalam Mode Read-Only (Hanya Lihat).'
    });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({
      error: 'Akses Ditolak: Fitur ini hanya untuk Super Admin.'
    });
  }
  next();
}

function requireDeviceKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== DEVICE_API_KEY) {
    return res.status(403).json({ error: 'Invalid Device API Key' });
  }
  next();
}

// ============================================================================
// 1. ENDPOINTS UNTUK ESP32 CONTROLLER
// ============================================================================

app.post('/api/device/heartbeat', requireDeviceKey, (req, res) => {
  const {
    deviceId = 'pintu-utama',
    ip = '-',
    rssi = 0,
    bssid = '-',
    channel = 0,
    txPower = 0,
    isRelayUnlocked = false,
    isDoorOpenSensor = null,
    firmwareVersion = '-',
    boardType = '',
    chipModel = '',
    codeHash = '-',
    cardSyncVersion = 0,
    nvsCardCount = 0,
    policyVersion = 0,
    uptimeSec = 0,
    freeHeapKb = 0,
    otaStatus = 'IDLE'
  } = req.body;
  const cleanId = String(deviceId).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const defaultSiteId = Object.keys(db.sites)[0] || 'site-pusat';

  let isNewDoor = false;
  if (!db.doors[cleanId]) {
    isNewDoor = true;
    db.doors[cleanId] = {
      id: cleanId,
      name: `Pintu Baru (${cleanId})`,
      siteId: defaultSiteId,
      location: 'Otomatis Terdeteksi',
      mode: 'NORMAL',
      unlockDurationMs: 5000,
      lastSeen: Date.now(),
      ip,
      rssi,
      bssid: String(bssid || '-'),
      channel: Number(channel) || 0,
      txPower: Number(txPower) || 0,
      isRelayUnlocked: Boolean(isRelayUnlocked),
      unlockedUntil: 0,
      isPhysicallyOpen: false,
      holdOpenKeepAjar: false,
      doorAjarWarning: false,
      lastActorName: '-',
      lastCardUid: '-',
      firmwareVersion: String(firmwareVersion || '-'),
      boardType: String(boardType || '').toUpperCase().includes('S3') ? 'ESP32_S3' : 'ESP32_CP2102',
      chipModel: String(chipModel || (String(boardType || '').toUpperCase().includes('S3') ? 'ESP32-S3' : 'ESP32')),
      codeHash: String(codeHash || '-'),
      cardSyncVersion: Number(cardSyncVersion) || 0,
      desiredCardSyncVersion: Number(db.cardSyncVersion) || 1,
      nvsCardCount: Number(nvsCardCount) || 0,
      policyVersion: Number(policyVersion) || 0,
      sdnPolicy: { ...(db.sdnStandardPolicy || defaultSdnPolicy) },
      uptimeSec: Number(uptimeSec) || 0,
      freeHeapKb: Number(freeHeapKb) || 0,
      otaStatus: String(otaStatus || 'IDLE'),
      pendingCommand: null
    };
  }

  const door = db.doors[cleanId];
  const wasOffline = Date.now() - (door.lastSeen || 0) >= 10000;
  const cleanHash = String(codeHash || '-').trim();
  const normalizedBoard = boardType
    ? (String(boardType).toUpperCase().includes('S3') ? 'ESP32_S3' : 'ESP32_CP2102')
    : (door.boardType || 'ESP32_CP2102');
  const fwChanged = door.firmwareVersion !== String(firmwareVersion || '-') ||
                    door.boardType !== normalizedBoard ||
                    door.codeHash !== cleanHash ||
                    door.cardSyncVersion !== (Number(cardSyncVersion) || 0) ||
                    door.policyVersion !== (Number(policyVersion) || 0) ||
                    door.otaStatus !== String(otaStatus || 'IDLE');

  door.lastSeen = Date.now();
  door.ip = ip;
  door.rssi = rssi;
  door.bssid = String(bssid || '-');
  door.channel = Number(channel) || 0;
  door.txPower = Number(txPower) || 0;
  door.firmwareVersion = String(firmwareVersion || '-');
  door.boardType = normalizedBoard;
  if (chipModel) door.chipModel = String(chipModel);
  door.codeHash = cleanHash;
  door.cardSyncVersion = Number(cardSyncVersion) || 0;
  door.nvsCardCount = Number(nvsCardCount) || 0;
  door.policyVersion = Number(policyVersion) || 0;
  door.uptimeSec = Number(uptimeSec) || 0;
  door.freeHeapKb = Number(freeHeapKb) || 0;
  door.otaStatus = String(otaStatus || 'IDLE');
  if (!door.sdnPolicy) door.sdnPolicy = { ...(db.sdnStandardPolicy || defaultSdnPolicy) };

  if (door._pendingSyncOffer && Number(cardSyncVersion) >= Number(door._pendingSyncOffer.version)) {
    door.telemetry = {
      ...(door.telemetry || {}),
      nvsUids: door._pendingSyncOffer.entries,
      reportedAt: Date.now()
    };
    door.syncedUids = door._pendingSyncOffer.uids;
    door.nvsCardCount = door._pendingSyncOffer.entries.length;
    delete door._pendingSyncOffer;
    door._syncedOfferApplied = true;
  }

  if (typeof isDoorOpenSensor === 'boolean') {
    door.holdOpenKeepAjar = isDoorOpenSensor;
    if (!isDoorOpenSensor && (door.doorAjarWarning || (door.isPhysicallyOpen && Date.now() >= (door.unlockedUntil || 0)))) {
      markDoorPhysicallyClosed(door);
    }
  }

  const command = door.pendingCommand;
  door.pendingCommand = null;

  const offerApplied = Boolean(door._syncedOfferApplied);
  if (offerApplied) delete door._syncedOfferApplied;

  if (isNewDoor || wasOffline || command || fwChanged || offerApplied) {
    saveDb();
    broadcastUpdate();
  }

  const targetCardVer = Number(door.desiredCardSyncVersion) || Number(db.cardSyncVersion) || 1;
  const targetPolVer = Number(door.sdnPolicy?.version) || 1;
  const needSource = Boolean(cleanHash && cleanHash !== '-' && !hasSourceCode(cleanHash));
  const otaTargeted = Boolean(
    otaMeta.enabled &&
      fs.existsSync(FIRMWARE_BIN_FILE) &&
      (otaMeta.targetMode === 'ALL' || (Array.isArray(otaMeta.targetDoors) && otaMeta.targetDoors.includes(cleanId)))
  );

  return res.json({
    ok: true,
    mode: door.mode,
    unlockDurationMs: door.unlockDurationMs || 5000,
    command: command || null,
    cardSyncVersion: targetCardVer,
    policyVersion: targetPolVer,
    needSource,
    otaEnabled: otaTargeted,
    otaVersion: otaMeta.version || '',
    otaMd5: otaMeta.md5 || ''
  });
});

app.get('/api/device/policy', requireDeviceKey, (req, res) => {
  const rawDeviceId = String(req.query.deviceId || 'pintu-utama');
  const cleanId = rawDeviceId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const door = db.doors[cleanId];
  const pol = door?.sdnPolicy || db.sdnStandardPolicy || defaultSdnPolicy;
  return res.json({
    ok: true,
    deviceId: cleanId,
    policyVersion: Number(pol.version) || 1,
    antiBruteforce: Boolean(pol.antiBruteforce),
    bruteforceMaxFails: Number(pol.bruteforceMaxFails) || 3,
    lockoutDurationSec: Number(pol.lockoutDurationSec) || 15,
    sameCardCooldownMs: Number(pol.sameCardCooldownMs) || 2000,
    exitInLockdown: Boolean(pol.exitInLockdown),
    buzzerEnabled: Boolean(pol.buzzerEnabled),
    heartbeatIntervalMs: Number(pol.heartbeatIntervalMs) || 2500
  });
});

app.post('/api/device/source-upload', requireDeviceKey, (req, res) => {
  const rawCode = typeof req.body === 'string' ? req.body : '';
  if (!rawCode || rawCode.length < 50) {
    return res.status(400).json({ error: 'Source code body kosong atau tidak valid' });
  }
  const actualHash = crypto.createHash('sha256').update(rawCode, 'utf8').digest('hex').slice(0, 12);
  const reportedHash = String(req.headers['x-code-hash'] || actualHash).replace(/[^a-zA-Z0-9_-]/g, '');
  const deviceId = String(req.headers['x-device-id'] || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');

  const pActual = getSourceFilePath(actualHash);
  if (pActual) fs.writeFileSync(pActual, rawCode, 'utf8');
  if (reportedHash && reportedHash !== actualHash) {
    const pRep = getSourceFilePath(reportedHash);
    if (pRep) fs.writeFileSync(pRep, rawCode, 'utf8');
  }

  if (deviceId && db.doors[deviceId]) {
    db.doors[deviceId].codeHash = reportedHash || actualHash;
    db.doors[deviceId].lastInspectAt = Date.now();
    saveDb();
    broadcastUpdate();
  }

  return res.json({ ok: true, actualHash, reportedHash, bytes: rawCode.length });
});

app.post('/api/device/telemetry', requireDeviceKey, (req, res) => {
  const {
    deviceId = 'pintu-utama',
    firmwareVersion,
    codeHash,
    codeSha256,
    sourceBytes,
    uptimeSec,
    freeHeapKb,
    rssi,
    bssid,
    channel,
    txPower,
    defaultUnlockMs,
    pins,
    nvsUids
  } = req.body;
  const cleanId = String(deviceId).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const door = db.doors[cleanId];
  if (!door) {
    return res.status(404).json({ error: 'Door not found' });
  }

  door.telemetry = {
    firmwareVersion: firmwareVersion || door.firmwareVersion,
    codeHash: codeHash || door.codeHash,
    codeSha256: codeSha256 || '-',
    sourceBytes: Number(sourceBytes) || 0,
    uptimeSec: Number(uptimeSec) || 0,
    freeHeapKb: Number(freeHeapKb) || 0,
    rssi: Number(rssi) || 0,
    bssid: bssid || '-',
    channel: Number(channel) || 0,
    txPower: Number(txPower) || 0,
    defaultUnlockMs: Number(defaultUnlockMs) || door.unlockDurationMs,
    pins: pins || null,
    nvsUids: Array.isArray(nvsUids) ? nvsUids : [],
    reportedAt: Date.now()
  };
  door.lastInspectAt = Date.now();
  saveDb();
  broadcastUpdate();
  return res.json({ ok: true });
});

app.get('/api/device/sync-cards', requireDeviceKey, (req, res) => {
  const rawDeviceId = String(req.query.deviceId || 'pintu-utama');
  const cleanId = rawDeviceId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const door = db.doors[cleanId];
  const targetCardVer = Number(door?.desiredCardSyncVersion) || Number(db.cardSyncVersion) || 1;

  const matchingCards = db.cards.filter((c) => {
    if (!c.active || c.offlineSync === false) return false;
    const allowed = Array.isArray(c.allowedDoors) ? c.allowedDoors : ['*'];
    return allowed.includes('*') || allowed.includes(cleanId);
  });

  const uids = matchingCards.map((c) => String(c.uid).trim().toUpperCase());
  const entries = matchingCards.map((c) => `${String(c.uid).trim().toUpperCase()}:${Number(c.unlockDurationMs) || 0}`);

  if (door) {
    door._pendingSyncOffer = {
      version: targetCardVer,
      uids,
      entries,
      at: Date.now()
    };
  }

  return res.json({
    ok: true,
    deviceId: cleanId,
    cardSyncVersion: targetCardVer,
    uids,
    entries
  });
});

app.get('/api/device/firmware.bin', requireDeviceKey, (req, res) => {
  if (!fs.existsSync(FIRMWARE_BIN_FILE)) {
    return res.status(404).json({ error: 'Firmware binary not found' });
  }
  const stat = fs.statSync(FIRMWARE_BIN_FILE);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  if (otaMeta.md5) res.setHeader('x-MD5', otaMeta.md5);
  if (otaMeta.version) res.setHeader('x-Firmware-Version', otaMeta.version);
  return fs.createReadStream(FIRMWARE_BIN_FILE).pipe(res);
});

app.post('/api/device/event', requireDeviceKey, (req, res) => {
  const { deviceId = 'pintu-utama', type, cardUid, details } = req.body;
  const cleanId = String(deviceId).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const defaultSiteId = Object.keys(db.sites)[0] || 'site-pusat';

  if (!db.doors[cleanId]) {
    db.doors[cleanId] = {
      id: cleanId,
      name: `Pintu Baru (${cleanId})`,
      siteId: defaultSiteId,
      location: 'Otomatis Terdeteksi',
      mode: 'NORMAL',
      unlockDurationMs: 5000,
      lastSeen: Date.now(),
      ip: '-',
      rssi: 0,
      isRelayUnlocked: false,
      unlockedUntil: 0,
      isPhysicallyOpen: false,
      holdOpenKeepAjar: false,
      doorAjarWarning: false,
      lastActorName: '-',
      lastCardUid: '-',
      firmwareVersion: '-',
      cardSyncVersion: 0,
      otaStatus: 'IDLE',
      pendingCommand: null
    };
  }

  const door = db.doors[cleanId];
  door.lastSeen = Date.now();

  if (type === 'DOOR_CLOSED') {
    markDoorPhysicallyClosed(door);
    return res.json({ ok: true });
  }

  if (type === 'BRUTEFORCE_ALERT' || type === 'SECURITY_ALERT') {
    addLog({
      doorId: cleanId,
      doorName: door.name,
      siteId: door.siteId,
      eventType: 'SECURITY_ALERT',
      status: 'DENIED',
      actorName: 'Sistem Anti-Bruteforce',
      cardUid: String(cardUid || 'UNKNOWN').toUpperCase(),
      details: String(details || 'Percobaan kartu salah berulang kali! Reader dikunci sementara.')
    });
    return res.json({ ok: true });
  }

  if (type === 'EXIT_BUTTON') {
    const actor = 'Tombol Exit (Keluar dari Dalam)';
    if (door.mode === 'LOCKDOWN') {
      addLog({
        doorId: cleanId,
        doorName: door.name,
        siteId: door.siteId,
        eventType: 'EXIT_BUTTON',
        status: 'DENIED',
        actorName: actor,
        cardUid: 'PUSH-BUTTON',
        details: 'Ditolak karena pintu sedang mode LOCKDOWN'
      });
      return res.json({
        allow: false,
        reason: 'LOCKDOWN_ACTIVE',
        unlockDurationMs: 0
      });
    }

    const openMs = door.unlockDurationMs || 5000;
    addLog({
      doorId: cleanId,
      doorName: door.name,
      siteId: door.siteId,
      eventType: 'EXIT_BUTTON',
      status: 'GRANTED',
      actorName: actor,
      cardUid: 'PUSH-BUTTON',
      details: `Pintu terbuka ${Math.round(openMs / 1000)} detik dari dalam (Tombol Exit)`
    });

    triggerServerUnlockState(door, openMs, actor, 'PUSH-BUTTON');

    return res.json({
      allow: true,
      unlockDurationMs: openMs
    });
  }

  if (type === 'RFID_SCAN' || type === 'RFID_IN') {
    const cleanUid = String(cardUid || '').trim().toUpperCase();
    const existingCard = db.cards.find((c) => c.uid.toUpperCase() === cleanUid);
    const actorDisplay = existingCard ? `${existingCard.name} (${existingCard.role || 'Staff'})` : 'Kartu Belum Terdaftar';

    broadcastEvent(
      {
        type: 'CARD_SCANNED',
        cardUid: cleanUid,
        doorId: cleanId,
        doorName: door.name,
        siteId: door.siteId,
        alreadyRegistered: Boolean(existingCard),
        existingCard: existingCard || null,
        timestamp: new Date().toISOString()
      },
      door.siteId
    );

    if (door.mode === 'LOCKDOWN') {
      addLog({
        doorId: cleanId,
        doorName: door.name,
        siteId: door.siteId,
        eventType: 'RFID_IN',
        status: 'DENIED',
        actorName: actorDisplay,
        cardUid: cleanUid,
        details: 'Ditolak karena pintu sedang mode LOCKDOWN'
      });
      return res.json({
        allow: false,
        reason: 'LOCKDOWN_ACTIVE',
        unlockDurationMs: 0
      });
    }

    if (!existingCard) {
      addLog({
        doorId: cleanId,
        doorName: door.name,
        siteId: door.siteId,
        eventType: 'RFID_IN',
        status: 'DENIED',
        actorName: 'Kartu Belum Terdaftar',
        cardUid: cleanUid,
        details: 'UID kartu belum terdaftar (Klik tombol "+ Daftarkan" di samping)'
      });
      return res.json({
        allow: false,
        reason: 'CARD_NOT_FOUND',
        unlockDurationMs: 0
      });
    }

    if (!existingCard.active) {
      addLog({
        doorId: cleanId,
        doorName: door.name,
        siteId: door.siteId,
        eventType: 'RFID_IN',
        status: 'DENIED',
        actorName: actorDisplay,
        cardUid: cleanUid,
        details: 'Kartu sedang dinonaktifkan / diblokir'
      });
      return res.json({
        allow: false,
        reason: 'CARD_DISABLED',
        unlockDurationMs: 0
      });
    }

    const allowedDoors = Array.isArray(existingCard.allowedDoors) ? existingCard.allowedDoors : ['*'];
    const hasDoorPermission = allowedDoors.includes('*') || allowedDoors.includes(cleanId);

    if (!hasDoorPermission) {
      addLog({
        doorId: cleanId,
        doorName: door.name,
        siteId: door.siteId,
        eventType: 'RFID_IN',
        status: 'DENIED',
        actorName: actorDisplay,
        cardUid: cleanUid,
        details: `Kartu milik ${existingCard.name} tidak memiliki izin akses untuk "${door.name}"`
      });
      return res.json({
        allow: false,
        reason: 'DOOR_NOT_AUTHORIZED',
        unlockDurationMs: 0
      });
    }

    const cardCustomMs = Number(existingCard.unlockDurationMs) || 0;
    const openMs = cardCustomMs > 0 ? cardCustomMs : (door.unlockDurationMs || 5000);
    const durSuffix = cardCustomMs > 0 ? ' [Durasi Khusus Kartu]' : '';
    addLog({
      doorId: cleanId,
      doorName: door.name,
      siteId: door.siteId,
      eventType: 'RFID_IN',
      status: 'GRANTED',
      actorName: actorDisplay,
      cardUid: cleanUid,
      details: `Pintu terbuka ${Math.round(openMs / 1000)} detik${durSuffix} — akses masuk oleh ${existingCard.name} (UID: ${cleanUid})`
    });

    triggerServerUnlockState(door, openMs, actorDisplay, cleanUid);

    return res.json({
      allow: true,
      userName: existingCard.name,
      unlockDurationMs: openMs
    });
  }

  return res.status(400).json({ error: 'Unknown event type' });
});

// ============================================================================
// 2. ENDPOINTS UNTUK WEB DASHBOARD CENTRALIZED (MULTI-SITE & RBAC)
// ============================================================================

app.post('/api/admin/login', (req, res) => {
  const { username = 'admin', password } = req.body;
  const cleanUser = String(username || 'admin').trim().toLowerCase();

  const found = db.admins.find(
    (a) => a.username.toLowerCase() === cleanUser && a.password === String(password || '')
  );

  if (!found) {
    return res.status(401).json({ error: 'Username atau Password salah!' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username: found.username, createdAt: Date.now() });

  return res.json({
    ok: true,
    token,
    user: sanitizeUser(found)
  });
});

app.get('/api/admin/state', requireAdmin, (req, res) => {
  const payload = buildStatePayloadForUser(req.user);
  const jsonBuf = Buffer.from(JSON.stringify(payload), 'utf-8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (String(req.headers['accept-encoding'] || '').includes('gzip')) {
    return zlib.gzip(jsonBuf, { level: 4 }, (err, gz) => {
      if (err) return res.send(jsonBuf);
      res.setHeader('Content-Encoding', 'gzip');
      return res.send(gz);
    });
  }
  return res.send(jsonBuf);
});

app.get('/api/admin/stream', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders?.();

  // Flush 2KB comment padding so reverse proxies (Nginx/Cloudflare/Traefik) stream immediately
  safeSseWrite(res, `:${' '.repeat(2048)}\n\n`);

  const initialPayload = buildStatePayloadForUser(req.user);
  safeSseWrite(res, `data: ${JSON.stringify(initialPayload)}\n\n`);

  sseClients.set(res, req.user);
  const keepAlive = setInterval(() => {
    safeSseWrite(res, ': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// ---------------- MANAJEMEN SITE / LOKASI CABANG (SUPER ADMIN) ----------------
app.post('/api/admin/sites', requireAdmin, requireSuperAdmin, (req, res) => {
  const { id, name, address = '' } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'Kode Site dan Nama Site wajib diisi.' });
  }
  const cleanId = String(id).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  db.sites[cleanId] = {
    id: cleanId,
    name: String(name).trim(),
    address: String(address).trim(),
    createdAt: db.sites[cleanId]?.createdAt || new Date().toISOString()
  };
  saveDb();
  broadcastUpdate();
  return res.json({ ok: true, site: db.sites[cleanId] });
});

app.delete('/api/admin/sites/:siteId', requireAdmin, requireSuperAdmin, (req, res) => {
  const siteId = req.params.siteId;
  if (Object.keys(db.sites).length <= 1) {
    return res.status(400).json({ error: 'Minimal harus ada 1 Site aktif.' });
  }
  if (!db.sites[siteId]) {
    return res.status(404).json({ error: 'Site tidak ditemukan.' });
  }
  delete db.sites[siteId];
  const fallbackSiteId = Object.keys(db.sites)[0];
  for (const door of Object.values(db.doors)) {
    if (door.siteId === siteId) {
      door.siteId = fallbackSiteId;
    }
  }
  saveDb();
  broadcastUpdate();
  return res.json({ ok: true });
});

// ---------------- MANAJEMEN AKUN ADMIN & ROLE (SUPER ADMIN) ----------------
app.post('/api/admin/users', requireAdmin, requireSuperAdmin, (req, res) => {
  const {
    username,
    password,
    name,
    role = 'SITE_ADMIN',
    accessMode = 'READ_WRITE',
    allowedSites = ['*']
  } = req.body;

  if (!username || !name) {
    return res.status(400).json({ error: 'Username dan Nama Admin wajib diisi.' });
  }

  const cleanUsername = String(username).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
  const validRoles = ['SUPER_ADMIN', 'SITE_ADMIN', 'VIEWER'];
  const finalRole = validRoles.includes(role) ? role : 'SITE_ADMIN';
  // SUPER_ADMIN wajib selalu READ_WRITE & semua site; VIEWER wajib selalu READ_ONLY
  const finalMode =
    finalRole === 'SUPER_ADMIN'
      ? 'READ_WRITE'
      : finalRole === 'VIEWER' || accessMode === 'READ_ONLY'
      ? 'READ_ONLY'
      : 'READ_WRITE';
  const finalSites =
    finalRole === 'SUPER_ADMIN'
      ? ['*']
      : Array.isArray(allowedSites) && allowedSites.length
      ? allowedSites
      : ['*'];

  const existingIdx = db.admins.findIndex((a) => a.username.toLowerCase() === cleanUsername);
  if (existingIdx >= 0) {
    const existing = db.admins[existingIdx];
    // Jangan izinkan menurunkan role super admin utama terakhir
    const superAdminCount = db.admins.filter((a) => a.role === 'SUPER_ADMIN').length;
    if (existing.role === 'SUPER_ADMIN' && finalRole !== 'SUPER_ADMIN' && superAdminCount <= 1) {
      return res.status(400).json({ error: 'Tidak bisa mengubah role Super Admin terakhir!' });
    }
    db.admins[existingIdx] = {
      ...existing,
      name: String(name).trim(),
      password: password ? String(password) : existing.password,
      role: finalRole,
      accessMode: finalMode,
      allowedSites: finalSites
    };
  } else {
    if (!password) {
      return res.status(400).json({ error: 'Password wajib diisi untuk akun baru.' });
    }
    db.admins.push({
      username: cleanUsername,
      password: String(password),
      name: String(name).trim(),
      role: finalRole,
      accessMode: finalMode,
      allowedSites: finalSites,
      createdAt: new Date().toISOString()
    });
  }

  saveDb();
  broadcastUpdate();
  return res.json({ ok: true, admins: db.admins.map(sanitizeUser) });
});

app.delete('/api/admin/users/:username', requireAdmin, requireSuperAdmin, (req, res) => {
  const target = String(req.params.username || '').toLowerCase();
  const found = db.admins.find((a) => a.username.toLowerCase() === target);
  if (!found) {
    return res.status(404).json({ error: 'User tidak ditemukan.' });
  }
  if (found.role === 'SUPER_ADMIN' && db.admins.filter((a) => a.role === 'SUPER_ADMIN').length <= 1) {
    return res.status(400).json({ error: 'Tidak dapat menghapus Super Admin terakhir!' });
  }
  db.admins = db.admins.filter((a) => a.username.toLowerCase() !== target);
  saveDb();
  broadcastUpdate();
  return res.json({ ok: true });
});

// ---------------- MANAJEMEN PINTU / ESP32 ----------------
app.post('/api/admin/doors', requireAdmin, requireWriteAccess, (req, res) => {
  const { id, name, siteId = 'site-pusat', location = '', unlockDurationSeconds = 5, boardType } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'ID Perangkat (ESP32) dan Nama Pintu wajib diisi' });
  }

  const targetSiteId = db.sites[siteId] ? siteId : Object.keys(db.sites)[0];
  if (!canUserAccessSite(req.user, targetSiteId)) {
    return res.status(403).json({ error: 'Anda tidak memiliki izin untuk menambahkan/mengubah pintu di Site ini.' });
  }

  const cleanId = String(id).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const durationMs = Math.max(1, Math.min(60, Number(unlockDurationSeconds) || 5)) * 1000;
  const cleanBoard = String(boardType || '').toUpperCase().includes('S3') ? 'ESP32_S3' : 'ESP32_CP2102';

  if (db.doors[cleanId]) {
    if (!canUserAccessDoor(req.user, db.doors[cleanId])) {
      return res.status(403).json({ error: 'Anda tidak memiliki izin pada pintu ini.' });
    }
    db.doors[cleanId].name = String(name).trim();
    db.doors[cleanId].siteId = targetSiteId;
    db.doors[cleanId].location = String(location).trim();
    db.doors[cleanId].unlockDurationMs = durationMs;
    if (boardType) db.doors[cleanId].boardType = cleanBoard;
  } else {
    db.doors[cleanId] = {
      id: cleanId,
      name: String(name).trim(),
      siteId: targetSiteId,
      location: String(location).trim(),
      boardType: cleanBoard,
      chipModel: cleanBoard === 'ESP32_S3' ? 'ESP32-S3' : 'ESP32',
      mode: 'NORMAL',
      unlockDurationMs: durationMs,
      lastSeen: 0,
      ip: '-',
      rssi: 0,
      isRelayUnlocked: false,
      unlockedUntil: 0,
      isPhysicallyOpen: false,
      holdOpenKeepAjar: false,
      doorAjarWarning: false,
      lastActorName: '-',
      lastCardUid: '-',
      pendingCommand: null
    };
  }

  saveDb();
  broadcastUpdate();
  return res.json({ ok: true, door: db.doors[cleanId] });
});

app.delete('/api/admin/doors/:doorId', requireAdmin, requireWriteAccess, (req, res) => {
  const doorId = req.params.doorId;
  const door = db.doors[doorId];
  if (!door) {
    return res.status(404).json({ error: 'Pintu tidak ditemukan' });
  }
  if (!canUserAccessDoor(req.user, door)) {
    return res.status(403).json({ error: 'Anda tidak memiliki izin menghapus pintu di Site ini.' });
  }
  delete db.doors[doorId];
  saveDb();
  broadcastUpdate();
  return res.json({ ok: true });
});

// Remote Open (Buka Pintu dari Jarak Jauh)
app.post('/api/admin/door/open', requireAdmin, requireWriteAccess, (req, res) => {
  const { doorId = 'pintu-utama', durationMs, keepDoorAjar = false } = req.body;
  const door = db.doors[doorId];
  if (!door) {
    return res.status(404).json({ error: 'Pintu tidak ditemukan' });
  }
  if (!canUserAccessDoor(req.user, door)) {
    return res.status(403).json({ error: 'Anda tidak memiliki izin membuka pintu di Site ini.' });
  }

  const openMs = Number(durationMs) || door.unlockDurationMs || 5000;
  const openSec = Math.round(openMs / 1000);
  const actor = `${req.user.name} (Remote Web)`;

  door.pendingCommand = {
    action: 'OPEN_ONCE',
    durationMs: openMs,
    issuedAt: Date.now()
  };

  if (typeof keepDoorAjar === 'boolean') {
    door.holdOpenKeepAjar = keepDoorAjar;
  }

  addLog({
    doorId,
    doorName: door.name,
    siteId: door.siteId,
    eventType: 'REMOTE_OPEN',
    status: 'GRANTED',
    actorName: actor,
    cardUid: 'REMOTE-WEB',
    details: `Pintu dibuka manual oleh ${req.user.name} selama ${openSec} detik`
  });

  triggerServerUnlockState(door, openMs, actor, 'REMOTE-WEB');

  return res.json({ ok: true, message: 'Perintah buka pintu dikirim ke ESP32' });
});

// Simulasi Tap Kartu dari Web Dashboard
app.post('/api/admin/door/simulate-tap', requireAdmin, requireWriteAccess, (req, res) => {
  const { doorId = 'pintu-utama', cardUid, keepDoorAjar = false } = req.body;
  const door = db.doors[doorId];
  if (!door) {
    return res.status(404).json({ error: 'Pintu tidak ditemukan' });
  }
  if (!canUserAccessDoor(req.user, door)) {
    return res.status(403).json({ error: 'Anda tidak memiliki izin pada Site pintu ini.' });
  }

  const cleanUid = String(cardUid || '').trim().toUpperCase();
  const existingCard = db.cards.find((c) => c.uid.toUpperCase() === cleanUid);
  const actorDisplay = existingCard ? `${existingCard.name} (${existingCard.role || 'Staff'})` : 'Kartu Belum Terdaftar';

  if (door.mode === 'LOCKDOWN') {
    addLog({
      doorId,
      doorName: door.name,
      siteId: door.siteId,
      eventType: 'RFID_IN',
      status: 'DENIED',
      actorName: actorDisplay,
      cardUid: cleanUid,
      details: 'Ditolak karena pintu sedang mode LOCKDOWN'
    });
    return res.json({ allow: false });
  }

  if (!existingCard || !existingCard.active) {
    addLog({
      doorId,
      doorName: door.name,
      siteId: door.siteId,
      eventType: 'RFID_IN',
      status: 'DENIED',
      actorName: actorDisplay,
      cardUid: cleanUid,
      details: !existingCard ? 'UID kartu belum terdaftar' : 'Kartu sedang diblokir / nonaktif'
    });
    return res.json({ allow: false });
  }

  const allowedDoors = Array.isArray(existingCard.allowedDoors) ? existingCard.allowedDoors : ['*'];
  if (!allowedDoors.includes('*') && !allowedDoors.includes(doorId)) {
    addLog({
      doorId,
      doorName: door.name,
      siteId: door.siteId,
      eventType: 'RFID_IN',
      status: 'DENIED',
      actorName: actorDisplay,
      cardUid: cleanUid,
      details: `Kartu milik ${existingCard.name} tidak memiliki izin akses untuk "${door.name}"`
    });
    return res.json({ allow: false });
  }

  door.holdOpenKeepAjar = Boolean(keepDoorAjar);
  const cardCustomMs = Number(existingCard.unlockDurationMs) || 0;
  const openMs = cardCustomMs > 0 ? cardCustomMs : (door.unlockDurationMs || 5000);

  door.pendingCommand = {
    action: 'OPEN_ONCE',
    durationMs: openMs,
    issuedAt: Date.now()
  };

  addLog({
    doorId,
    doorName: door.name,
    siteId: door.siteId,
    eventType: 'RFID_IN',
    status: 'GRANTED',
    actorName: actorDisplay,
    cardUid: cleanUid,
    details: `Pintu terbuka ${Math.round(openMs / 1000)} detik — simulasi tap oleh ${existingCard.name} (UID: ${cleanUid})`
  });

  triggerServerUnlockState(door, openMs, actorDisplay, cleanUid);
  return res.json({ allow: true });
});

app.post('/api/admin/door/physical-state', requireAdmin, requireWriteAccess, (req, res) => {
  const { doorId = 'pintu-utama', action } = req.body;
  const door = db.doors[doorId];
  if (!door) {
    return res.status(404).json({ error: 'Pintu tidak ditemukan' });
  }
  if (!canUserAccessDoor(req.user, door)) {
    return res.status(403).json({ error: 'Anda tidak memiliki izin pada pintu ini.' });
  }

  if (action === 'CLOSE_DOOR') {
    markDoorPhysicallyClosed(door);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown physical-state action' });
});

app.post('/api/admin/door/mode', requireAdmin, requireWriteAccess, (req, res) => {
  const { doorId = 'pintu-utama', mode } = req.body;
  const validModes = ['NORMAL', 'HOLD_OPEN', 'LOCKDOWN'];
  if (!validModes.includes(mode)) {
    return res.status(400).json({ error: 'Mode tidak valid' });
  }

  const door = db.doors[doorId];
  if (!door) {
    return res.status(404).json({ error: 'Pintu tidak ditemukan' });
  }
  if (!canUserAccessDoor(req.user, door)) {
    return res.status(403).json({ error: 'Anda tidak memiliki izin mengubah mode pintu di Site ini.' });
  }

  if (doorTimers[door.id]) {
    clearTimeout(doorTimers[door.id]);
    delete doorTimers[door.id];
  }

  door.mode = mode;
  if (mode === 'HOLD_OPEN') {
    door.isRelayUnlocked = true;
    door.isPhysicallyOpen = true;
    door.doorAjarWarning = false;
  } else {
    door.unlockedUntil = 0;
    door.isRelayUnlocked = false;
    door.isPhysicallyOpen = false;
    door.doorAjarWarning = false;
  }

  const modeLabels = {
    NORMAL: 'Normal (tertutup & terkunci otomatis)',
    HOLD_OPEN: 'Buka Terus (magnet dilepas permanen)',
    LOCKDOWN: 'Lockdown (terkunci total, semua akses ditolak)'
  };

  addLog({
    doorId,
    doorName: door.name,
    siteId: door.siteId,
    eventType: 'REMOTE_MODE',
    status: mode === 'LOCKDOWN' ? 'DENIED' : 'INFO',
    actorName: `${req.user.name} (Remote Web)`,
    cardUid: 'REMOTE-WEB',
    details: `Mengubah mode pintu ke: ${modeLabels[mode]}`
  });

  return res.json({ ok: true, mode: door.mode });
});

app.post('/api/admin/doors/bulk-mode', requireAdmin, requireWriteAccess, (req, res) => {
  const { siteId = 'ALL', mode } = req.body;
  const validModes = ['NORMAL', 'HOLD_OPEN', 'LOCKDOWN'];
  if (!validModes.includes(mode)) {
    return res.status(400).json({ error: 'Mode tidak valid' });
  }

  if (siteId !== 'ALL' && !canUserAccessSite(req.user, siteId)) {
    return res.status(403).json({ error: 'Anda tidak memiliki izin mengubah mode pada Site ini.' });
  }

  const targetDoors = Object.values(db.doors).filter((door) => {
    if (!canUserAccessDoor(req.user, door)) return false;
    if (siteId !== 'ALL' && door.siteId !== siteId) return false;
    return true;
  });

  if (!targetDoors.length) {
    return res.status(404).json({ error: 'Tidak ada pintu yang tersedia untuk diubah.' });
  }

  const scopeLabel = siteId === 'ALL' ? 'Semua Site' : (db.sites[siteId]?.name || siteId);
  const modeLabels = {
    NORMAL: 'Normal (tertutup & terkunci otomatis)',
    HOLD_OPEN: 'Buka Terus (magnet dilepas permanen)',
    LOCKDOWN: 'Lockdown (terkunci total, semua akses ditolak)'
  };

  const nowIso = new Date().toISOString();
  for (const door of targetDoors) {
    if (doorTimers[door.id]) {
      clearTimeout(doorTimers[door.id]);
      delete doorTimers[door.id];
    }

    door.mode = mode;
    if (mode === 'HOLD_OPEN') {
      door.isRelayUnlocked = true;
      door.isPhysicallyOpen = true;
      door.doorAjarWarning = false;
    } else {
      door.unlockedUntil = 0;
      door.isRelayUnlocked = false;
      door.isPhysicallyOpen = false;
      door.doorAjarWarning = false;
      if (mode === 'LOCKDOWN') {
        door.pendingCommand = null;
      }
    }

    const resolvedSiteName = db.sites[door.siteId]?.name || door.siteId;
    db.logs.unshift({
      id: crypto.randomUUID(),
      timestamp: nowIso,
      doorId: door.id,
      doorName: door.name,
      siteId: door.siteId,
      siteName: resolvedSiteName,
      eventType: 'REMOTE_MODE',
      status: mode === 'LOCKDOWN' ? 'DENIED' : 'INFO',
      actorName: `${req.user.name} (Remote Web)`,
      cardUid: 'REMOTE-WEB',
      details: `Kendali massal (${scopeLabel}): mengubah mode pintu ke ${modeLabels[mode]}`
    });
  }

  if (db.logs.length > 1000) {
    db.logs = db.logs.slice(0, 1000);
  }
  saveDb();
  broadcastUpdate();

  return res.json({
    ok: true,
    mode,
    updatedCount: targetDoors.length,
    scopeLabel
  });
});

// ---------------- UBAH DURASI BUKA PER PINTU / ESP32 ----------------
app.patch('/api/admin/door/duration', requireAdmin, requireWriteAccess, (req, res) => {
  const { doorId = 'pintu-utama', unlockDurationSeconds } = req.body;
  const door = db.doors[doorId];
  if (!door) {
    return res.status(404).json({ error: 'Pintu tidak ditemukan' });
  }
  if (!canUserAccessDoor(req.user, door)) {
    return res.status(403).json({ error: 'Anda tidak memiliki izin mengubah durasi pintu di Site ini.' });
  }

  const sec = Math.max(1, Math.min(60, Math.round(Number(unlockDurationSeconds) || 5)));
  door.unlockDurationMs = sec * 1000;

  addLog({
    doorId,
    doorName: door.name,
    siteId: door.siteId,
    eventType: 'DOOR_CONFIG',
    status: 'INFO',
    actorName: `${req.user.name} (Remote Web)`,
    cardUid: `${sec} DETIK`,
    details: `Mengubah durasi buka default pintu "${door.name}" menjadi ${sec} detik`
  });

  saveDb();
  broadcastUpdate();
  return res.json({ ok: true, doorId, unlockDurationMs: door.unlockDurationMs, unlockDurationSeconds: sec });
});

// ---------------- MANAJEMEN KARTU RFID ----------------
app.post('/api/admin/cards', requireAdmin, requireWriteAccess, (req, res) => {
  const { uid, name, role = 'Staff', allowedDoors = ['*'], active = true, unlockDurationSeconds = 0 } = req.body;
  if (!uid || !name) {
    return res.status(400).json({ error: 'UID Kartu dan Nama wajib diisi' });
  }

  const cleanUid = String(uid).trim().toUpperCase();
  const parsedSec = Number(unlockDurationSeconds) || 0;
  const cardDurationMs = parsedSec > 0 ? Math.max(1, Math.min(60, Math.round(parsedSec))) * 1000 : 0;
  let normalizedDoors =
    Array.isArray(allowedDoors) && allowedDoors.length > 0 ? allowedDoors : ['*'];

  // Jika bukan Super Admin dan hanya pegang site tertentu, batasi allowedDoors ke pintu di site-nya
  if (!isSuperAdmin(req.user) && !(req.user.allowedSites || []).includes('*')) {
    const myDoorIds = Object.values(db.doors)
      .filter((d) => canUserAccessDoor(req.user, d))
      .map((d) => d.id);
    if (normalizedDoors.includes('*')) {
      normalizedDoors = myDoorIds;
    } else {
      normalizedDoors = normalizedDoors.filter((dId) => myDoorIds.includes(dId));
    }
  }

  const existingIdx = db.cards.findIndex((c) => c.uid.toUpperCase() === cleanUid);

  if (existingIdx >= 0) {
    db.cards[existingIdx] = {
      ...db.cards[existingIdx],
      uid: cleanUid,
      name: String(name).trim(),
      role: String(role).trim(),
      allowedDoors: normalizedDoors,
      unlockDurationMs: cardDurationMs,
      active: Boolean(active)
    };
  } else {
    db.cards.unshift({
      uid: cleanUid,
      name: String(name).trim(),
      role: String(role).trim(),
      allowedDoors: normalizedDoors,
      unlockDurationMs: cardDurationMs,
      offlineSync: true,
      active: Boolean(active),
      createdAt: new Date().toISOString()
    });
  }

  bumpCardSyncVersion();
  saveDb();
  broadcastUpdate();
  return res.json({ ok: true, cards: db.cards, cardSyncVersion: db.cardSyncVersion });
});

app.patch('/api/admin/cards/:uid/toggle', requireAdmin, requireWriteAccess, (req, res) => {
  const cleanUid = String(req.params.uid).trim().toUpperCase();
  const card = db.cards.find((c) => c.uid.toUpperCase() === cleanUid);
  if (!card) {
    return res.status(404).json({ error: 'Kartu tidak ditemukan' });
  }
  card.active = !card.active;
  bumpCardSyncVersion();
  saveDb();
  broadcastUpdate();
  return res.json({ ok: true, card, cardSyncVersion: db.cardSyncVersion });
});

app.delete('/api/admin/cards/:uid', requireAdmin, requireWriteAccess, (req, res) => {
  const cleanUid = String(req.params.uid).trim().toUpperCase();
  db.cards = db.cards.filter((c) => c.uid.toUpperCase() !== cleanUid);
  bumpCardSyncVersion();
  saveDb();
  broadcastUpdate();
  return res.json({ ok: true, cardSyncVersion: db.cardSyncVersion });
});

app.post('/api/admin/cards/push-sync', requireAdmin, requireWriteAccess, (req, res) => {
  const {
    cardUids = [],
    targetMode = 'ALL',
    targetDoors = [],
    forceSyncOnly = false
  } = req.body;

  const mode = targetMode === 'SELECTED' ? 'SELECTED' : 'ALL';
  const cleanDoors = Array.isArray(targetDoors)
    ? targetDoors
        .map((d) => String(d).trim())
        .filter((d) => db.doors[d] && canUserAccessDoor(req.user, db.doors[d]))
    : [];

  if (mode === 'SELECTED' && cleanDoors.length === 0) {
    return res.status(400).json({ error: 'Pilih minimal 1 pintu tujuan untuk push 1-1.' });
  }

  let updatedCardsCount = 0;
  if (!forceSyncOnly) {
    const uidSet = new Set(
      (Array.isArray(cardUids) ? cardUids : []).map((u) => String(u).trim().toUpperCase()).filter(Boolean)
    );
    if (uidSet.size === 0) {
      return res.status(400).json({ error: 'Pilih minimal 1 kartu dari Cloud untuk di-push ke ESP32.' });
    }

    const accessibleDoorIds = Object.values(db.doors)
      .filter((d) => canUserAccessDoor(req.user, d))
      .map((d) => d.id);

    for (const card of db.cards) {
      if (!uidSet.has(String(card.uid).toUpperCase())) continue;
      card.active = true;
      card.offlineSync = true;
      if (mode === 'ALL') {
        if (isSuperAdmin(req.user) || (req.user.allowedSites || []).includes('*')) {
          card.allowedDoors = ['*'];
        } else {
          const prev = Array.isArray(card.allowedDoors) ? card.allowedDoors : [];
          if (!prev.includes('*')) {
            card.allowedDoors = Array.from(new Set([...prev, ...accessibleDoorIds]));
          }
        }
      } else {
        const prev = Array.isArray(card.allowedDoors) ? card.allowedDoors : [];
        if (!prev.includes('*')) {
          card.allowedDoors = Array.from(new Set([...prev, ...cleanDoors]));
        }
      }
      updatedCardsCount++;
    }
  }

  bumpCardSyncVersion(mode === 'SELECTED' ? cleanDoors : null);
  saveDb();

  const scopeText = mode === 'ALL' ? 'SEMUA PINTU (Massal)' : cleanDoors.join(', ');
  addLog({
    doorId: mode === 'SELECTED' && cleanDoors.length === 1 ? cleanDoors[0] : 'SYSTEM',
    doorName: mode === 'SELECTED' && cleanDoors.length === 1 ? (db.doors[cleanDoors[0]]?.name || cleanDoors[0]) : 'Cloud Card Sync',
    siteId: Object.keys(db.sites)[0] || 'site-pusat',
    eventType: 'CARD_SYNC',
    status: 'INFO',
    actorName: `${req.user.name} (Remote Web)`,
    cardUid: forceSyncOnly ? 'SYNC-NVS' : `${updatedCardsCount} KARTU`,
    details: forceSyncOnly
      ? `Memicu sinkronisasi ulang kartu offline ke ESP32: ${scopeText}`
      : `Push ${updatedCardsCount} kartu Cloud ke memori NVS lokal ESP32 (${scopeText})`
  });

  broadcastUpdate();
  return res.json({
    ok: true,
    targetMode: mode,
    targetDoors: cleanDoors,
    updatedCardsCount,
    cardSyncVersion: db.cardSyncVersion
  });
});

// ---------------- CLOUD OTA FIRMWARE MASS UPDATE & 1-1 (SUPER ADMIN) ----------------
app.post('/api/admin/firmware/upload', requireAdmin, requireSuperAdmin, (req, res) => {
  const {
    version,
    notes = '',
    dataBase64,
    autoRollout = true,
    targetMode = 'ALL',
    targetDoors = []
  } = req.body;
  const cleanVer = String(version || '').trim();
  if (!cleanVer) {
    return res.status(400).json({ error: 'Nomor versi firmware wajib diisi (misal: 2.1.0)' });
  }
  if (!dataBase64 || typeof dataBase64 !== 'string') {
    return res.status(400).json({ error: 'File firmware .bin wajib diunggah' });
  }

  const normalizedMode = targetMode === 'SELECTED' ? 'SELECTED' : 'ALL';
  const normalizedDoors = Array.isArray(targetDoors)
    ? targetDoors.map((d) => String(d).trim()).filter((d) => Boolean(db.doors[d]))
    : [];

  if (autoRollout && normalizedMode === 'SELECTED' && normalizedDoors.length === 0) {
    return res.status(400).json({ error: 'Pilih minimal 1 pintu tujuan untuk OTA mode 1-1.' });
  }

  let binBuffer;
  try {
    const cleanB64 = dataBase64.replace(/^data:[^;]+;base64,/, '').trim();
    binBuffer = Buffer.from(cleanB64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'Format file base64 tidak valid' });
  }

  if (!binBuffer || binBuffer.length < 10240 || binBuffer[0] !== 0xE9) {
    return res.status(400).json({ error: 'File bukan binary firmware ESP32 yang valid (magic byte 0xE9 tidak ditemukan).' });
  }

  if (!fs.existsSync(FIRMWARE_DIR)) {
    fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
  }
  fs.writeFileSync(FIRMWARE_BIN_FILE, binBuffer);

  const md5 = crypto.createHash('md5').update(binBuffer).digest('hex');
  const sha256 = crypto.createHash('sha256').update(binBuffer).digest('hex');

  otaMeta = {
    enabled: Boolean(autoRollout),
    version: cleanVer,
    md5,
    sha256,
    size: binBuffer.length,
    notes: String(notes || '').trim(),
    targetMode: normalizedMode,
    targetDoors: normalizedDoors,
    uploadedAt: new Date().toISOString()
  };
  saveOtaMeta();

  const targetDesc = normalizedMode === 'ALL' ? 'Massal Semua Pintu' : `Pintu Terpilih (${normalizedDoors.join(', ')})`;
  addLog({
    doorId: 'SYSTEM',
    doorName: 'Cloud OTA Server',
    siteId: Object.keys(db.sites)[0] || 'site-pusat',
    eventType: 'CLOUD_OTA',
    status: 'INFO',
    actorName: `${req.user.name} (Super Admin)`,
    cardUid: `v${cleanVer}`,
    details: `Mengunggah firmware OTA v${cleanVer} (${Math.round(binBuffer.length / 1024)} KB, Target: ${targetDesc}, Status: ${otaMeta.enabled ? 'AKTIF' : 'PAUSED'})`
  });

  broadcastUpdate();
  return res.json({ ok: true, ota: otaMeta });
});

app.post('/api/admin/firmware/rollout', requireAdmin, requireSuperAdmin, (req, res) => {
  const { enabled, targetMode, targetDoors } = req.body;
  if (!fs.existsSync(FIRMWARE_BIN_FILE) || !otaMeta.version) {
    return res.status(400).json({ error: 'Belum ada file firmware .bin yang diunggah.' });
  }
  otaMeta.enabled = Boolean(enabled);
  if (targetMode === 'ALL' || targetMode === 'SELECTED') {
    otaMeta.targetMode = targetMode;
  }
  if (Array.isArray(targetDoors)) {
    otaMeta.targetDoors = targetDoors.map((d) => String(d).trim()).filter((d) => Boolean(db.doors[d]));
  }
  if (otaMeta.enabled && otaMeta.targetMode === 'SELECTED' && (!otaMeta.targetDoors || otaMeta.targetDoors.length === 0)) {
    return res.status(400).json({ error: 'Pilih minimal 1 pintu tujuan untuk OTA mode 1-1.' });
  }
  saveOtaMeta();

  const targetDesc = otaMeta.targetMode === 'ALL' ? 'Massal Semua Pintu' : `Pintu Terpilih (${otaMeta.targetDoors.join(', ')})`;
  addLog({
    doorId: 'SYSTEM',
    doorName: 'Cloud OTA Server',
    siteId: Object.keys(db.sites)[0] || 'site-pusat',
    eventType: 'CLOUD_OTA',
    status: 'INFO',
    actorName: `${req.user.name} (Super Admin)`,
    cardUid: `v${otaMeta.version}`,
    details: `Rollout OTA v${otaMeta.version}: ${otaMeta.enabled ? 'AKTIF' : 'PAUSED'} · Target: ${targetDesc}`
  });

  broadcastUpdate();
  return res.json({ ok: true, ota: otaMeta });
});

// ---------------- SDN ORCHESTRATION & LIVE CODE INTROSPECTION ----------------
app.get('/api/admin/door/:doorId/code', requireAdmin, (req, res) => {
  const doorId = String(req.params.doorId || '').trim();
  const door = db.doors[doorId];
  if (!door) {
    return res.status(404).json({ error: 'Pintu tidak ditemukan.' });
  }
  if (!canUserAccessDoor(req.user, door)) {
    return res.status(403).json({ error: 'Anda tidak memiliki akses ke pintu ini.' });
  }

  const codeHash = String(door.codeHash || door.telemetry?.codeHash || '').trim();
  const sourcePath = getSourceFilePath(codeHash);
  let sourceCode = '';
  let hasSource = false;
  if (sourcePath && fs.existsSync(sourcePath)) {
    try {
      sourceCode = fs.readFileSync(sourcePath, 'utf-8');
      hasSource = Boolean(sourceCode);
    } catch (err) {
      console.error('Error reading ESP32 source file:', err.message);
    }
  }

  return res.json({
    ok: true,
    door,
    codeHash: codeHash || '-',
    hasSource,
    sourceCode,
    telemetry: door.telemetry || null,
    sdnPolicy: door.sdnPolicy || db.sdnStandardPolicy || defaultSdnPolicy
  });
});

app.post('/api/admin/door/inspect', requireAdmin, requireWriteAccess, (req, res) => {
  const { targetMode = 'SELECTED', targetDoors = [], action = 'INSPECT_CODE' } = req.body || {};
  const allowedActions = ['INSPECT_CODE', 'REBOOT', 'SYNC_CARDS'];
  if (!allowedActions.includes(action)) {
    return res.status(400).json({ error: `Aksi tidak valid. Pilihan: ${allowedActions.join(', ')}` });
  }

  const mode = targetMode === 'ALL' ? 'ALL' : 'SELECTED';
  const cleanIds = Array.isArray(targetDoors)
    ? targetDoors.map((d) => String(d).trim()).filter(Boolean)
    : [];

  const matchedDoors = Object.values(db.doors).filter((d) => {
    if (!canUserAccessDoor(req.user, d)) return false;
    return mode === 'ALL' ? true : cleanIds.includes(d.id);
  });

  if (matchedDoors.length === 0) {
    return res.status(400).json({ error: 'Pilih minimal 1 pintu yang valid untuk menjalankan aksi SDN.' });
  }

  for (const door of matchedDoors) {
    door.pendingCommand = action;
    if (action === 'SYNC_CARDS') {
      bumpCardSyncVersion([door.id]);
    }
  }
  saveDb();

  const scopeText = mode === 'ALL' ? `Massal (${matchedDoors.length} pintu)` : matchedDoors.map((d) => d.id).join(', ');
  const actionLabels = {
    INSPECT_CODE: 'Live Code & Telemetry Inspection',
    REBOOT: 'Remote Reboot ESP32',
    SYNC_CARDS: 'Paksa Sync Kartu NVS'
  };
  addLog({
    doorId: matchedDoors.length === 1 ? matchedDoors[0].id : 'SYSTEM',
    doorName: matchedDoors.length === 1 ? matchedDoors[0].name : 'SDN Orchestrator',
    siteId: matchedDoors.length === 1 ? matchedDoors[0].siteId : (Object.keys(db.sites)[0] || 'site-pusat'),
    eventType: 'SDN_ORCHESTRATION',
    status: 'INFO',
    actorName: `${req.user.name} (SDN)`,
    cardUid: action,
    details: `${actionLabels[action]} -> ${scopeText}`
  });

  broadcastUpdate();
  return res.json({ ok: true, action, targetMode: mode, targetDoors: matchedDoors.map((d) => d.id) });
});

app.post('/api/admin/sdn/policy', requireAdmin, requireWriteAccess, (req, res) => {
  const { targetMode = 'ALL', targetDoors = [], policy = {} } = req.body || {};
  const mode = targetMode === 'SELECTED' ? 'SELECTED' : 'ALL';
  const cleanIds = Array.isArray(targetDoors)
    ? targetDoors.map((d) => String(d).trim()).filter(Boolean)
    : [];

  const matchedDoors = Object.values(db.doors).filter((d) => {
    if (!canUserAccessDoor(req.user, d)) return false;
    return mode === 'ALL' ? true : cleanIds.includes(d.id);
  });

  if (mode === 'SELECTED' && matchedDoors.length === 0) {
    return res.status(400).json({ error: 'Pilih minimal 1 pintu tujuan untuk SDN Policy 1-1.' });
  }

  const basePolicy = {
    antiBruteforce: policy.antiBruteforce !== undefined ? Boolean(policy.antiBruteforce) : defaultSdnPolicy.antiBruteforce,
    bruteforceMaxFails: Math.max(1, Math.min(20, Number(policy.bruteforceMaxFails) || defaultSdnPolicy.bruteforceMaxFails)),
    lockoutDurationSec: Math.max(3, Math.min(300, Number(policy.lockoutDurationSec) || defaultSdnPolicy.lockoutDurationSec)),
    sameCardCooldownMs: Math.max(300, Math.min(15000, Number(policy.sameCardCooldownMs) || defaultSdnPolicy.sameCardCooldownMs)),
    exitInLockdown: Boolean(policy.exitInLockdown),
    buzzerEnabled: policy.buzzerEnabled !== undefined ? Boolean(policy.buzzerEnabled) : defaultSdnPolicy.buzzerEnabled,
    heartbeatIntervalMs: Math.max(1000, Math.min(30000, Number(policy.heartbeatIntervalMs) || defaultSdnPolicy.heartbeatIntervalMs))
  };

  if (mode === 'ALL' && (isSuperAdmin(req.user) || (req.user.allowedSites || []).includes('*'))) {
    const nextStdVer = (Number(db.sdnStandardPolicy?.version) || 1) + 1;
    db.sdnStandardPolicy = { ...basePolicy, version: nextStdVer };
  }

  for (const door of matchedDoors) {
    const prevVer = Number(door.sdnPolicy?.version) || Number(door.policyVersion) || 1;
    const nextVer = mode === 'ALL' && db.sdnStandardPolicy?.version
      ? Math.max(db.sdnStandardPolicy.version, prevVer + 1)
      : prevVer + 1;
    door.sdnPolicy = { ...basePolicy, version: nextVer };
  }
  saveDb();

  const scopeText = mode === 'ALL' ? `Massal (${matchedDoors.length} pintu)` : matchedDoors.map((d) => d.id).join(', ');
  addLog({
    doorId: matchedDoors.length === 1 ? matchedDoors[0].id : 'SYSTEM',
    doorName: matchedDoors.length === 1 ? matchedDoors[0].name : 'SDN Control Plane',
    siteId: matchedDoors.length === 1 ? matchedDoors[0].siteId : (Object.keys(db.sites)[0] || 'site-pusat'),
    eventType: 'SDN_POLICY',
    status: 'INFO',
    actorName: `${req.user.name} (SDN)`,
    cardUid: `Pol v${matchedDoors[0]?.sdnPolicy?.version || db.sdnStandardPolicy?.version || 1}`,
    details: `Update SDN Policy (${scopeText}): AntiBrute=${basePolicy.antiBruteforce ? `ON(${basePolicy.bruteforceMaxFails}x/${basePolicy.lockoutDurationSec}s)` : 'OFF'}, Cooldown=${basePolicy.sameCardCooldownMs}ms, ExitLockdown=${basePolicy.exitInLockdown ? 'ALLOW' : 'BLOCK'}, Buzzer=${basePolicy.buzzerEnabled ? 'ON' : 'OFF'}`
  });

  broadcastUpdate();
  return res.json({
    ok: true,
    targetMode: mode,
    targetDoors: matchedDoors.map((d) => d.id),
    sdnStandardPolicy: db.sdnStandardPolicy
  });
});

// ---------------- ISOLATED ACCESS-DOOR FACE RECOGNITION DB & PERMIT/DENY ROLES ----------------
const FACE_AI_CANDIDATE_URLS = [
  process.env.FACE_RECOG_URL,
  'http://192.168.1.100:8090',
  'http://192.168.1.105:8090',
  'http://presensi_app:8080'
].filter(Boolean);

const SFACE_MATCH_THRESHOLD = Number(process.env.SFACE_THRESHOLD) || 0.38;
let activeFaceAiBaseUrl = FACE_AI_CANDIDATE_URLS[0] || 'http://192.168.1.100:8090';

async function fetchStatelessFaceAi(apiPath, options = {}, timeoutMs = 8000) {
  const orderedUrls = [
    activeFaceAiBaseUrl,
    ...FACE_AI_CANDIDATE_URLS.filter((u) => u !== activeFaceAiBaseUrl)
  ];

  let lastErr = null;
  for (const base of orderedUrls) {
    try {
      const resp = await fetch(`${base}${apiPath}`, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const err = new Error(data.error || data.message || `HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      activeFaceAiBaseUrl = base;
      return { data, baseUrl: base };
    } catch (err) {
      lastErr = err;
      // Jangan fallback ke host lain jika error berasal dari AI (mis. 422 wajah tidak terdeteksi)
      if (err.status && err.status >= 400 && err.status < 500) {
        throw err;
      }
    }
  }
  throw lastErr || new Error('Engine AI Face Recognition tidak terjangkau');
}

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
    return -1;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA <= 0 || normB <= 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sfaceSimilarityToConfidence(sim) {
  if (!Number.isFinite(sim) || sim < -1) return 0;
  const pct = ((sim - 0.05) / 0.7) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function findBestAccessFaceMatch(probeEmbedding, threshold = SFACE_MATCH_THRESHOLD) {
  let bestFace = null;
  let bestSim = -1;

  for (const face of facesDb) {
    if (!Array.isArray(face.embedding) || face.embedding.length !== 128) continue;
    const sim = cosineSimilarity(probeEmbedding, face.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      bestFace = face;
    }
  }

  if (bestFace && bestSim >= threshold) {
    return {
      matched: true,
      face: bestFace,
      similarity: Number(bestSim.toFixed(4)),
      confidence: sfaceSimilarityToConfidence(bestSim)
    };
  }

  return {
    matched: false,
    face: null,
    similarity: bestSim > -1 ? Number(bestSim.toFixed(4)) : null,
    confidence: bestSim > -1 ? sfaceSimilarityToConfidence(bestSim) : 0
  };
}

app.get('/api/admin/face-db/status', requireAdmin, async (_req, res) => {
  try {
    const healthRes = await fetchStatelessFaceAi('/api/ai/health', { method: 'GET' }, 3500);
    return res.json({
      ok: true,
      connected: true,
      aiHealth: healthRes.data || { available: true },
      totalFaces: facesDb.length,
      activeFaces: facesDb.filter((f) => f.active !== false).length,
      faces: facesDb.map(sanitizeFaceForClient)
    });
  } catch (err) {
    return res.json({
      ok: true,
      connected: false,
      aiHealth: { available: false, error: err.message },
      error: err.message || 'Engine AI tidak terjangkau',
      totalFaces: facesDb.length,
      activeFaces: facesDb.filter((f) => f.active !== false).length,
      faces: facesDb.map(sanitizeFaceForClient)
    });
  }
});

app.get('/api/admin/faces', requireAdmin, (_req, res) => {
  return res.json({
    ok: true,
    faces: facesDb.map(sanitizeFaceForClient)
  });
});

app.post('/api/admin/faces', requireAdmin, requireWriteAccess, async (req, res) => {
  const {
    name,
    role = 'Staff',
    photoBase64,
    defaultPolicy = 'DENY',
    doorRules = {}
  } = req.body || {};

  const cleanName = String(name || '').trim();
  if (!cleanName) {
    return res.status(400).json({ error: 'Nama pemilik wajah wajib diisi.' });
  }
  if (!photoBase64 || typeof photoBase64 !== 'string') {
    return res.status(400).json({ error: 'Foto wajah wajib diambil atau diunggah.' });
  }

  try {
    const { data } = await fetchStatelessFaceAi(
      '/api/ai/extract',
      {
        method: 'POST',
        body: JSON.stringify({ imageBase64: photoBase64 })
      },
      9000
    );

    if (!Array.isArray(data?.embedding) || data.embedding.length !== 128) {
      return res.status(422).json({ error: 'Wajah tidak terdeteksi jelas pada foto. Coba ambil ulang dengan cahaya cukup.' });
    }

    const dup = findBestAccessFaceMatch(data.embedding, 0.48);
    if (dup.matched && dup.face) {
      return res.status(409).json({
        error: `Wajah ini sudah terdaftar di DB Access Door sebagai "${dup.face.name}" (${dup.confidence}%). Gunakan menu Edit jika ingin mengubah role pintunya.`
      });
    }

    const nowIso = new Date().toISOString();
    const newFace = {
      id: `face-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      name: cleanName,
      role: String(role || 'Staff').trim(),
      active: true,
      defaultPolicy: String(defaultPolicy || 'DENY').toUpperCase() === 'PERMIT' ? 'PERMIT' : 'DENY',
      doorRules: sanitizeFaceRules(doorRules),
      photoBase64,
      embedding: data.embedding.map(Number),
      createdAt: nowIso,
      updatedAt: nowIso
    };

    facesDb.unshift(newFace);
    saveFacesDb();

    addLog({
      doorId: 'SYSTEM',
      doorName: 'Face ID Database',
      siteId: Object.keys(db.sites)[0] || 'site-pusat',
      eventType: 'FACE_ENROLL',
      status: 'INFO',
      actorName: `${req.user.name} (Admin)`,
      cardUid: 'FACE-DB',
      details: `Mendaftarkan wajah baru "${newFace.name}" (${newFace.role}, Default: ${newFace.defaultPolicy})`
    });

    broadcastUpdate();
    return res.json({ ok: true, face: sanitizeFaceForClient(newFace) });
  } catch (err) {
    const status = err.status === 422 ? 422 : 503;
    return res.status(status).json({
      error: err.message || 'Gagal mengekstrak fitur wajah lewat engine AI'
    });
  }
});

app.put('/api/admin/faces/:faceId', requireAdmin, requireWriteAccess, async (req, res) => {
  const faceId = String(req.params.faceId || '').trim();
  const face = facesDb.find((f) => f.id === faceId);
  if (!face) {
    return res.status(404).json({ error: 'Data wajah tidak ditemukan di DB Access Door.' });
  }

  const { name, role, active, defaultPolicy, doorRules, photoBase64 } = req.body || {};

  if (photoBase64 && typeof photoBase64 === 'string' && photoBase64 !== face.photoBase64) {
    try {
      const { data } = await fetchStatelessFaceAi(
        '/api/ai/extract',
        { method: 'POST', body: JSON.stringify({ imageBase64: photoBase64 }) },
        9000
      );
      if (!Array.isArray(data?.embedding) || data.embedding.length !== 128) {
        return res.status(422).json({ error: 'Wajah tidak terdeteksi jelas pada foto baru.' });
      }
      face.photoBase64 = photoBase64;
      face.embedding = data.embedding.map(Number);
    } catch (err) {
      return res.status(err.status === 422 ? 422 : 503).json({ error: err.message });
    }
  }

  if (name !== undefined && String(name).trim()) face.name = String(name).trim();
  if (role !== undefined) face.role = String(role || 'Staff').trim();
  if (active !== undefined) face.active = Boolean(active);
  if (defaultPolicy !== undefined) {
    face.defaultPolicy = String(defaultPolicy).toUpperCase() === 'PERMIT' ? 'PERMIT' : 'DENY';
  }
  if (doorRules !== undefined) {
    face.doorRules = sanitizeFaceRules(doorRules);
  }
  face.updatedAt = new Date().toISOString();

  saveFacesDb();
  addLog({
    doorId: 'SYSTEM',
    doorName: 'Face ID Database',
    siteId: Object.keys(db.sites)[0] || 'site-pusat',
    eventType: 'FACE_ENROLL',
    status: 'INFO',
    actorName: `${req.user.name} (Admin)`,
    cardUid: 'FACE-DB',
    details: `Memperbarui role/profil wajah "${face.name}" (Aktif: ${face.active ? 'YA' : 'TIDAK'}, Default: ${face.defaultPolicy})`
  });

  broadcastUpdate();
  return res.json({ ok: true, face: sanitizeFaceForClient(face) });
});

app.delete('/api/admin/faces/:faceId', requireAdmin, requireWriteAccess, (req, res) => {
  const faceId = String(req.params.faceId || '').trim();
  const idx = facesDb.findIndex((f) => f.id === faceId);
  if (idx < 0) {
    return res.status(404).json({ error: 'Data wajah tidak ditemukan.' });
  }
  const [removed] = facesDb.splice(idx, 1);
  saveFacesDb();

  addLog({
    doorId: 'SYSTEM',
    doorName: 'Face ID Database',
    siteId: Object.keys(db.sites)[0] || 'site-pusat',
    eventType: 'FACE_ENROLL',
    status: 'WARN',
    actorName: `${req.user.name} (Admin)`,
    cardUid: 'FACE-DB',
    details: `Menghapus wajah "${removed.name}" dari DB Access Door`
  });

  broadcastUpdate();
  return res.json({ ok: true });
});

app.post('/api/admin/door/face-unlock', requireAdmin, requireWriteAccess, async (req, res) => {
  const {
    doorId = 'pintu-utama',
    imageBase64,
    durationMs,
    autoUnlock = true,
    logDenied = false
  } = req.body || {};

  const door = db.doors[doorId];
  if (!door) {
    return res.status(404).json({ error: 'Pintu tidak ditemukan.' });
  }
  if (!canUserAccessDoor(req.user, door)) {
    return res.status(403).json({ error: 'Anda tidak memiliki izin membuka pintu di Site ini.' });
  }
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'Frame kamera (imageBase64) wajib dikirim.' });
  }

  try {
    let extracted = null;
    try {
      const { data } = await fetchStatelessFaceAi(
        '/api/ai/extract',
        {
          method: 'POST',
          body: JSON.stringify({ imageBase64 })
        },
        8000
      );
      extracted = data;
    } catch (err) {
      // 422 dari /api/ai/extract berarti tidak ada wajah pada frame kamera
      if (err.status === 422) {
        return res.json({
          ok: true,
          matched: false,
          permitted: false,
          unlocked: false,
          faceDetected: false,
          faces: [],
          imageWidth: 640,
          imageHeight: 480,
          inferenceMs: 0,
          engine: 'YuNet+SFace'
        });
      }
      throw err;
    }

    const box = extracted.box || { x: 0, y: 0, width: 0, height: 0 };
    const match = findBestAccessFaceMatch(extracted.embedding, SFACE_MATCH_THRESHOLD);

    if (!match.matched || !match.face) {
      const unmatchedBox = {
        box,
        matched: false,
        permitted: false,
        name: null,
        confidence: match.confidence || 0,
        similarity: match.similarity
      };
      if (logDenied) {
        addLog({
          doorId,
          doorName: door.name,
          siteId: door.siteId,
          eventType: 'FACE_UNLOCK',
          status: 'DENIED',
          actorName: 'Wajah Belum Terdaftar (Face ID)',
          cardUid: 'FACE-ID',
          details: `Akses kamera ke ${door.name} ditolak: wajah belum terdaftar di DB Access Door (kemiripan ${match.confidence || 0}%).`
        });
        saveDb();
        broadcastUpdate();
      }
      return res.json({
        ok: true,
        matched: false,
        permitted: false,
        unlocked: false,
        faceDetected: true,
        closestConfidence: match.confidence || 0,
        closestSimilarity: match.similarity,
        faces: [unmatchedBox],
        imageWidth: extracted.imageWidth || 640,
        imageHeight: extracted.imageHeight || 480,
        inferenceMs: extracted.inferenceMs || 0,
        engine: extracted.engine || 'YuNet+SFace'
      });
    }

    const face = match.face;
    const permission = face.active === false ? 'INACTIVE' : getFaceDoorPermission(face, doorId);
    const actor = `${face.name} (${face.role || 'Face ID'})`;
    const faceOverlayItem = {
      box,
      matched: true,
      permitted: permission === 'PERMIT',
      permission,
      userId: face.id,
      name: face.name,
      role: face.role,
      confidence: match.confidence,
      similarity: match.similarity
    };

    if (permission !== 'PERMIT') {
      const reasonText = permission === 'INACTIVE'
        ? `Akun wajah "${face.name}" sedang dinonaktifkan.`
        : `Role pintu ${door.name} untuk "${face.name}" adalah DENY.`;

      if (logDenied || permission === 'DENY') {
        addLog({
          doorId,
          doorName: door.name,
          siteId: door.siteId,
          eventType: 'FACE_UNLOCK',
          status: 'DENIED',
          actorName: actor,
          cardUid: 'FACE-ID',
          details: `Wajah cocok (${match.confidence}%), DITOLAK: ${reasonText}`
        });
        saveDb();
        broadcastUpdate();
      }

      return res.json({
        ok: true,
        matched: true,
        permitted: false,
        unlocked: false,
        reason: permission,
        error: reasonText,
        doorId: door.id,
        doorName: door.name,
        person: faceOverlayItem,
        faces: [faceOverlayItem],
        imageWidth: extracted.imageWidth || 640,
        imageHeight: extracted.imageHeight || 480,
        inferenceMs: extracted.inferenceMs || 0,
        engine: extracted.engine || 'YuNet+SFace'
      });
    }

    if (door.mode === 'LOCKDOWN') {
      addLog({
        doorId,
        doorName: door.name,
        siteId: door.siteId,
        eventType: 'FACE_UNLOCK',
        status: 'DENIED',
        actorName: actor,
        cardUid: 'FACE-ID',
        details: `Wajah cocok (${match.confidence}% · PERMIT), namun ditolak karena pintu sedang mode LOCKDOWN!`
      });
      saveDb();
      broadcastUpdate();
      return res.json({
        ok: true,
        matched: true,
        permitted: true,
        unlocked: false,
        lockdown: true,
        error: 'Pintu sedang dalam mode LOCKDOWN! Akses wajah ditolak.',
        person: faceOverlayItem,
        faces: [faceOverlayItem],
        imageWidth: extracted.imageWidth || 640,
        imageHeight: extracted.imageHeight || 480,
        inferenceMs: extracted.inferenceMs || 0,
        engine: extracted.engine || 'YuNet+SFace'
      });
    }

    let unlocked = false;
    const openMs = Math.max(1000, Math.min(60000, Number(durationMs) || door.unlockDurationMs || 5000));
    const openSec = Math.round(openMs / 1000);

    if (autoUnlock !== false) {
      unlocked = true;
      door.pendingCommand = {
        action: 'OPEN_ONCE',
        durationMs: openMs,
        issuedAt: Date.now()
      };

      addLog({
        doorId,
        doorName: door.name,
        siteId: door.siteId,
        eventType: 'FACE_UNLOCK',
        status: 'GRANTED',
        actorName: actor,
        cardUid: 'FACE-ID',
        details: `Wajah cocok ${match.confidence}% (sim ${match.similarity} · Role: PERMIT). Pintu dibuka ${openSec} detik.`
      });

      triggerServerUnlockState(door, openMs, actor, 'FACE-ID');
    }

    return res.json({
      ok: true,
      matched: true,
      permitted: true,
      unlocked,
      doorId: door.id,
      doorName: door.name,
      durationMs: openMs,
      person: faceOverlayItem,
      faces: [faceOverlayItem],
      imageWidth: extracted.imageWidth || 640,
      imageHeight: extracted.imageHeight || 480,
      inferenceMs: extracted.inferenceMs || 0,
      engine: extracted.engine || 'YuNet+SFace'
    });
  } catch (err) {
    return res.status(503).json({
      error: `Gagal memproses Face Recognition (${err.message || 'Engine AI unreachable'})`
    });
  }
});

// Broadcast status tiap 1 detik jika ada pintu yang sedang countdown buka
setInterval(() => {
  const anyActiveCountdown = Object.values(db.doors).some((d) => (d.unlockedUntil || 0) > Date.now());
  if (anyActiveCountdown) {
    broadcastUpdate();
  }
}, 1000);

setInterval(() => {
  broadcastUpdate();
}, 5000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Centralized Access Door] Server berjalan di port ${PORT}`);
});
