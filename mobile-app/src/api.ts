import * as SecureStore from 'expo-secure-store';
import {
  AdminStatePayload,
  AdminUser,
  DoorMode,
  FaceUnlockResponse,
  SdnPolicy,
} from './types';

const KEY_SERVER_URL = 'acd_server_url';
const KEY_TOKEN = 'acd_admin_token';
const KEY_BIOMETRIC = 'acd_biometric_enabled';

export const DEFAULT_SERVER_URL = 'https://access-door.example.com';

export async function getSavedConfig(): Promise<{
  serverUrl: string;
  token: string | null;
  biometricEnabled: boolean;
}> {
  const [serverUrl, token, bio] = await Promise.all([
    SecureStore.getItemAsync(KEY_SERVER_URL),
    SecureStore.getItemAsync(KEY_TOKEN),
    SecureStore.getItemAsync(KEY_BIOMETRIC),
  ]);
  return {
    serverUrl: serverUrl || DEFAULT_SERVER_URL,
    token,
    biometricEnabled: bio !== 'false',
  };
}

export async function saveAuthSession(serverUrl: string, token: string): Promise<void> {
  const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
  await Promise.all([
    SecureStore.setItemAsync(KEY_SERVER_URL, cleanUrl),
    SecureStore.setItemAsync(KEY_TOKEN, token),
  ]);
}

export async function clearAuthSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_TOKEN);
}

export async function saveBiometricPref(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(KEY_BIOMETRIC, enabled ? 'true' : 'false');
}

async function apiRequest<T>(
  serverUrl: string,
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const base = serverUrl.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['x-admin-token'] = token;
  }

  const res = await fetch(`${base}${path}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export async function loginAdmin(
  serverUrl: string,
  username: string,
  password: string
): Promise<{ ok: boolean; token: string; user: AdminUser }> {
  return apiRequest(serverUrl, '/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function fetchAdminState(
  serverUrl: string,
  token: string
): Promise<AdminStatePayload> {
  return apiRequest(serverUrl, '/api/admin/state', { method: 'GET' }, token);
}

// Doors
export async function remoteOpenDoor(
  serverUrl: string,
  token: string,
  doorId: string,
  durationMs?: number
): Promise<{ ok: boolean; message?: string }> {
  return apiRequest(
    serverUrl,
    '/api/admin/door/open',
    { method: 'POST', body: JSON.stringify({ doorId, durationMs }) },
    token
  );
}

export async function changeDoorMode(
  serverUrl: string,
  token: string,
  doorId: string,
  mode: DoorMode
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    '/api/admin/door/mode',
    { method: 'POST', body: JSON.stringify({ doorId, mode }) },
    token
  );
}

export async function bulkChangeDoorMode(
  serverUrl: string,
  token: string,
  mode: DoorMode
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    '/api/admin/doors/bulk-mode',
    { method: 'POST', body: JSON.stringify({ mode }) },
    token
  );
}

export async function simulateDoorTap(
  serverUrl: string,
  token: string,
  doorId: string,
  cardUid: string
): Promise<{ ok: boolean; allow?: boolean; message?: string }> {
  return apiRequest(
    serverUrl,
    '/api/admin/door/simulate-tap',
    { method: 'POST', body: JSON.stringify({ doorId, cardUid }) },
    token
  );
}

export async function upsertDoor(
  serverUrl: string,
  token: string,
  door: {
    id: string;
    name: string;
    siteId: string;
    location?: string;
    unlockDurationSeconds?: number;
    boardType?: string;
  }
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    '/api/admin/doors',
    { method: 'POST', body: JSON.stringify(door) },
    token
  );
}

export async function deleteDoor(
  serverUrl: string,
  token: string,
  doorId: string
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    `/api/admin/doors/${encodeURIComponent(doorId)}`,
    { method: 'DELETE' },
    token
  );
}

// Live Face Unlock & Face DB
export async function faceUnlockDoor(
  serverUrl: string,
  token: string,
  doorId: string,
  imageBase64: string,
  durationMs = 5000,
  logDenied = false
): Promise<FaceUnlockResponse> {
  return apiRequest(
    serverUrl,
    '/api/admin/door/face-unlock',
    {
      method: 'POST',
      body: JSON.stringify({
        doorId,
        imageBase64,
        durationMs,
        autoUnlock: true,
        logDenied,
      }),
    },
    token
  );
}

export async function getFaceDbStatus(
  serverUrl: string,
  token: string
): Promise<{ ok: boolean; online?: boolean; engine?: string; error?: string }> {
  return apiRequest(serverUrl, '/api/admin/face-db/status', { method: 'GET' }, token);
}

export async function createFace(
  serverUrl: string,
  token: string,
  payload: {
    name: string;
    role: string;
    photoBase64: string;
    defaultPolicy: 'PERMIT' | 'DENY';
    doorRules: Record<string, 'PERMIT' | 'DENY'>;
  }
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    '/api/admin/faces',
    { method: 'POST', body: JSON.stringify(payload) },
    token
  );
}

export async function updateFace(
  serverUrl: string,
  token: string,
  faceId: string,
  payload: {
    name: string;
    role: string;
    active: boolean;
    defaultPolicy: 'PERMIT' | 'DENY';
    doorRules: Record<string, 'PERMIT' | 'DENY'>;
    photoBase64?: string;
  }
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    `/api/admin/faces/${encodeURIComponent(faceId)}`,
    { method: 'PUT', body: JSON.stringify(payload) },
    token
  );
}

export async function deleteFace(
  serverUrl: string,
  token: string,
  faceId: string
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    `/api/admin/faces/${encodeURIComponent(faceId)}`,
    { method: 'DELETE' },
    token
  );
}

// Cards
export async function upsertCard(
  serverUrl: string,
  token: string,
  card: {
    uid: string;
    name: string;
    role: string;
    active: boolean;
    allowedDoors?: string[];
    unlockDurationSeconds?: number;
  }
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    '/api/admin/cards',
    {
      method: 'POST',
      body: JSON.stringify({
        ...card,
        allowedDoors: card.allowedDoors || ['*'],
      }),
    },
    token
  );
}

export async function removeCard(
  serverUrl: string,
  token: string,
  uid: string
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    `/api/admin/cards/${encodeURIComponent(uid)}`,
    { method: 'DELETE' },
    token
  );
}

export async function pushSyncCards(
  serverUrl: string,
  token: string
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    '/api/admin/cards/push-sync',
    { method: 'POST', body: JSON.stringify({}) },
    token
  );
}

// SDN Policy
export async function saveSdnPolicy(
  serverUrl: string,
  token: string,
  payload: {
    targetMode: 'ALL' | 'SELECTED';
    targetDoors: string[];
    policy: Partial<SdnPolicy>;
  }
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    '/api/admin/sdn/policy',
    { method: 'POST', body: JSON.stringify(payload) },
    token
  );
}

// Sites & Users (Super Admin)
export async function upsertSite(
  serverUrl: string,
  token: string,
  site: { id: string; name: string; address?: string }
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    '/api/admin/sites',
    { method: 'POST', body: JSON.stringify(site) },
    token
  );
}

export async function deleteSite(
  serverUrl: string,
  token: string,
  siteId: string
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    `/api/admin/sites/${encodeURIComponent(siteId)}`,
    { method: 'DELETE' },
    token
  );
}

export async function upsertAdminUser(
  serverUrl: string,
  token: string,
  user: {
    username: string;
    password?: string;
    name: string;
    role: string;
    accessMode: string;
    allowedSites: string[];
  }
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    '/api/admin/users',
    { method: 'POST', body: JSON.stringify(user) },
    token
  );
}

export async function deleteAdminUser(
  serverUrl: string,
  token: string,
  username: string
): Promise<{ ok: boolean }> {
  return apiRequest(
    serverUrl,
    `/api/admin/users/${encodeURIComponent(username)}`,
    { method: 'DELETE' },
    token
  );
}
