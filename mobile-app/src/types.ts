export type DoorMode = 'NORMAL' | 'HOLD_OPEN' | 'LOCKDOWN';

export interface AdminUser {
  username: string;
  name: string;
  role: 'SUPER_ADMIN' | 'SITE_ADMIN' | 'VIEWER' | string;
  accessMode: 'READ_WRITE' | 'READ_ONLY' | string;
  allowedSites: string[];
}

export interface SiteInfo {
  id: string;
  name: string;
  address?: string;
}

export interface SdnPolicy {
  version?: number;
  antiBruteforce: boolean;
  bruteforceMaxFails: number;
  lockoutDurationSec: number;
  sameCardCooldownMs: number;
  exitInLockdown: boolean;
  buzzerEnabled: boolean;
  heartbeatIntervalMs: number;
}

export interface DoorInfo {
  id: string;
  name: string;
  siteId?: string;
  location?: string;
  mode: DoorMode;
  online: boolean;
  isRelayUnlocked?: boolean;
  isPhysicallyOpen?: boolean;
  doorAjarWarning?: boolean;
  firmwareVersion?: string;
  boardType?: string;
  chipModel?: string;
  unlockDurationMs?: number;
  lastSeen?: number;
  rssi?: number;
  ip?: string;
  sdnPolicy?: SdnPolicy;
}

export interface AccessLogItem {
  id: string;
  timestamp: number;
  doorId: string;
  doorName?: string;
  siteId?: string;
  eventType: string;
  status: 'GRANTED' | 'DENIED' | 'INFO' | 'ALERT' | string;
  actorName?: string;
  cardUid?: string;
  details?: string;
}

export interface RfidCardItem {
  uid: string;
  name: string;
  role?: string;
  allowedDoors: string[];
  active: boolean;
  unlockDurationMs?: number;
}

export interface FaceItem {
  id: string;
  name: string;
  role?: string;
  active: boolean;
  defaultPolicy: 'PERMIT' | 'DENY';
  doorRules: Record<string, 'PERMIT' | 'DENY'>;
  photoBase64?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface FaceOverlayBox {
  box?: { x: number; y: number; width: number; height: number };
  matched: boolean;
  permitted: boolean;
  permission?: string;
  name: string | null;
  confidence: number;
}

export interface FaceUnlockResponse {
  ok: boolean;
  matched: boolean;
  permitted: boolean;
  unlocked: boolean;
  lockdown?: boolean;
  faceDetected?: boolean;
  closestConfidence?: number;
  doorName?: string;
  person?: {
    id: string;
    name: string;
    role?: string;
    confidence: number;
    permission?: string;
  };
  faces?: FaceOverlayBox[];
  imageWidth?: number;
  imageHeight?: number;
  inferenceMs?: number;
  engine?: string;
  error?: string;
}

export interface AdminStatePayload {
  currentUser: AdminUser;
  sites: Record<string, SiteInfo>;
  doors: Record<string, DoorInfo>;
  logs: AccessLogItem[];
  cards: RfidCardItem[];
  admins: AdminUser[];
  sdnStandardPolicy?: SdnPolicy;
  faces: FaceItem[];
  serverNow: number;
}
