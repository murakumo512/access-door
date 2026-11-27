import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import {
  bulkChangeDoorMode,
  changeDoorMode,
  deleteDoor,
  remoteOpenDoor,
  simulateDoorTap,
  upsertDoor,
} from '../api';
import { AdminUser, DoorInfo, DoorMode, SiteInfo } from '../types';

interface Props {
  serverUrl: string;
  token: string;
  user: AdminUser;
  doors: DoorInfo[];
  sites: Record<string, SiteInfo>;
  biometricEnabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenLiveFace: (doorId: string) => void;
}

export function DoorsScreen({
  serverUrl,
  token,
  user,
  doors,
  sites,
  biometricEnabled,
  refreshing,
  onRefresh,
  onOpenLiveFace,
}: Props) {
  const [busyDoor, setBusyDoor] = useState<string | null>(null);
  const canWrite = user.accessMode !== 'READ_ONLY';

  // Add/Edit Door Modal
  const [doorModal, setDoorModal] = useState(false);
  const [doorIdInput, setDoorIdInput] = useState('');
  const [doorNameInput, setDoorNameInput] = useState('');
  const [doorSiteId, setDoorSiteId] = useState(Object.keys(sites)[0] || 'site-pusat');
  const [doorBoard, setDoorBoard] = useState<'ESP32_CP2102' | 'ESP32_S3'>('ESP32_CP2102');
  const [doorDurSec, setDoorDurSec] = useState('5');
  const [savingDoor, setSavingDoor] = useState(false);

  // Simulate Tap Modal
  const [tapModalDoor, setTapModalDoor] = useState<DoorInfo | null>(null);
  const [tapUid, setTapUid] = useState('');

  async function verifyBiometric(reason: string): Promise<boolean> {
    if (!biometricEnabled) return true;
    try {
      const hasHw = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHw || !enrolled) return true;

      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        cancelLabel: 'Batal',
        fallbackLabel: 'Gunakan PIN HP',
      });
      return res.success;
    } catch {
      return false;
    }
  }

  async function handleOpenDoor(door: DoorInfo) {
    if (!canWrite) {
      Alert.alert('Akses Terbatas', 'Akun Anda berstatus Read-Only.');
      return;
    }
    const ok = await verifyBiometric(`Verifikasi untuk membuka ${door.name}`);
    if (!ok) return;

    setBusyDoor(door.id);
    try {
      await remoteOpenDoor(serverUrl, token, door.id);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Berhasil', `Perintah buka ${door.name} sudah dikirim ke ESP32.`);
      onRefresh();
    } catch (err: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Gagal', err?.message || 'Tidak bisa membuka pintu.');
    } finally {
      setBusyDoor(null);
    }
  }

  async function handleModeChange(door: DoorInfo, mode: DoorMode) {
    if (!canWrite || door.mode === mode) return;
    const label =
      mode === 'HOLD_OPEN'
        ? 'BUKA TERUS'
        : mode === 'LOCKDOWN'
          ? 'LOCKDOWN'
          : 'NORMAL';

    Alert.alert('Ubah Mode Pintu', `Ubah ${door.name} ke mode ${label}?`, [
      { text: 'Batal', style: 'cancel' },
      {
        text: 'Ya, Ubah',
        style: mode === 'LOCKDOWN' ? 'destructive' : 'default',
        onPress: async () => {
          const ok = await verifyBiometric(`Konfirmasi mode ${label}`);
          if (!ok) return;
          setBusyDoor(door.id);
          try {
            await changeDoorMode(serverUrl, token, door.id, mode);
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onRefresh();
          } catch (err: any) {
            Alert.alert('Gagal', err?.message || 'Gagal mengubah mode pintu.');
          } finally {
            setBusyDoor(null);
          }
        },
      },
    ]);
  }

  async function handleBulkMode(mode: DoorMode) {
    if (!canWrite) return;
    const label =
      mode === 'HOLD_OPEN'
        ? 'BUKA SEMUA PINTU'
        : mode === 'LOCKDOWN'
          ? 'LOCKDOWN SEMUA PINTU'
          : 'NORMAL SEMUA PINTU';

    Alert.alert('Kontrol Massal', `Terapkan mode ${label}?`, [
      { text: 'Batal', style: 'cancel' },
      {
        text: 'Terapkan',
        style: mode === 'LOCKDOWN' ? 'destructive' : 'default',
        onPress: async () => {
          const ok = await verifyBiometric(`Konfirmasi ${label}`);
          if (!ok) return;
          try {
            await bulkChangeDoorMode(serverUrl, token, mode);
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onRefresh();
          } catch (err: any) {
            Alert.alert('Gagal', err?.message || 'Gagal mengubah mode massal.');
          }
        },
      },
    ]);
  }

  async function handleSaveDoor() {
    if (!doorIdInput.trim() || !doorNameInput.trim()) {
      Alert.alert('Validasi', 'ID Pintu dan Nama Pintu wajib diisi.');
      return;
    }
    setSavingDoor(true);
    try {
      await upsertDoor(serverUrl, token, {
        id: doorIdInput.trim(),
        name: doorNameInput.trim(),
        siteId: doorSiteId || Object.keys(sites)[0] || 'site-pusat',
        boardType: doorBoard,
        unlockDurationSeconds: Number(doorDurSec) || 5,
      });
      setDoorModal(false);
      setDoorIdInput('');
      setDoorNameInput('');
      onRefresh();
    } catch (err: any) {
      Alert.alert('Gagal', err?.message || 'Tidak bisa menyimpan pintu.');
    } finally {
      setSavingDoor(false);
    }
  }

  function handleDeleteDoor(door: DoorInfo) {
    if (!canWrite) return;
    Alert.alert('Hapus Pintu', `Hapus pintu "${door.name}" (${door.id})?`, [
      { text: 'Batal', style: 'cancel' },
      {
        text: 'Hapus',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteDoor(serverUrl, token, door.id);
            onRefresh();
          } catch (err: any) {
            Alert.alert('Gagal', err?.message || 'Tidak bisa menghapus pintu.');
          }
        },
      },
    ]);
  }

  async function handleSimulateTap() {
    if (!tapModalDoor || !tapUid.trim()) return;
    try {
      const res = await simulateDoorTap(serverUrl, token, tapModalDoor.id, tapUid.trim());
      setTapModalDoor(null);
      setTapUid('');
      Alert.alert(
        res.allow ? 'Akses Diterima' : 'Akses Ditolak',
        res.message || (res.allow ? 'Simulasi tap berhasil membuka pintu.' : 'Kartu ditolak.')
      );
      onRefresh();
    } catch (err: any) {
      Alert.alert('Gagal', err?.message || 'Simulasi tap gagal.');
    }
  }

  return (
    <View style={styles.flex}>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#10b981"
          />
        }
      >
        <View style={styles.summaryRow}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryNum}>{doors.length}</Text>
            <Text style={styles.summaryLbl}>Total Pintu</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={[styles.summaryNum, { color: '#34d399' }]}>
              {doors.filter((d) => d.online).length}
            </Text>
            <Text style={styles.summaryLbl}>Online</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={[styles.summaryNum, { color: '#fbbf24' }]}>
              {doors.filter((d) => d.isRelayUnlocked || d.mode === 'HOLD_OPEN').length}
            </Text>
            <Text style={styles.summaryLbl}>Terbuka</Text>
          </View>
        </View>

        {canWrite ? (
          <View style={styles.bulkBar}>
            <Pressable
              onPress={() => handleBulkMode('NORMAL')}
              style={styles.bulkBtn}
            >
              <Text style={styles.bulkText}>Normal Semua</Text>
            </Pressable>
            <Pressable
              onPress={() => handleBulkMode('HOLD_OPEN')}
              style={styles.bulkBtn}
            >
              <Text style={[styles.bulkText, { color: '#fbbf24' }]}>Buka Semua</Text>
            </Pressable>
            <Pressable
              onPress={() => handleBulkMode('LOCKDOWN')}
              style={styles.bulkBtn}
            >
              <Text style={[styles.bulkText, { color: '#fca5a5' }]}>Lockdown Semua</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDoorIdInput('');
                setDoorNameInput('');
                setDoorSiteId(Object.keys(sites)[0] || 'site-pusat');
                setDoorModal(true);
              }}
              style={styles.addDoorPill}
            >
              <Ionicons name="add" size={16} color="#052e16" />
            </Pressable>
          </View>
        ) : null}

        {doors.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="lock-closed-outline" size={32} color="#64748b" />
            <Text style={styles.emptyText}>Belum ada pintu terdaftar di site Anda.</Text>
          </View>
        ) : (
          doors.map((door) => {
            const isBusy = busyDoor === door.id;
            const siteName = door.siteId ? sites[door.siteId]?.name || door.siteId : 'Pusat';
            const isUnlocked = Boolean(door.isRelayUnlocked || door.mode === 'HOLD_OPEN');
            const modeColor =
              door.mode === 'LOCKDOWN'
                ? '#ef4444'
                : door.mode === 'HOLD_OPEN'
                  ? '#f59e0b'
                  : '#10b981';

            return (
              <View key={door.id} style={styles.doorCard}>
                <View style={styles.doorHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.doorName}>{door.name}</Text>
                    <Text style={styles.doorMeta}>
                      {siteName} · {door.boardType || 'ESP32'} · v{door.firmwareVersion || '?'}
                      {door.rssi ? ` · ${door.rssi} dBm` : ''}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusPill,
                      {
                        backgroundColor: door.online
                          ? 'rgba(16,185,129,0.15)'
                          : 'rgba(239,68,68,0.15)',
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: door.online ? '#10b981' : '#ef4444' },
                      ]}
                    />
                    <Text
                      style={[
                        styles.statusText,
                        { color: door.online ? '#34d399' : '#fca5a5' },
                      ]}
                    >
                      {door.online ? 'ONLINE' : 'OFFLINE'}
                    </Text>
                  </View>
                </View>

                <View style={styles.badgeRow}>
                  <View style={[styles.modeBadge, { borderColor: modeColor }]}>
                    <Text style={[styles.modeBadgeText, { color: modeColor }]}>
                      MODE: {door.mode}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.relayBadge,
                      {
                        backgroundColor: isUnlocked
                          ? 'rgba(251,191,36,0.16)'
                          : 'rgba(148,163,184,0.12)',
                      },
                    ]}
                  >
                    <Ionicons
                      name={isUnlocked ? 'lock-open' : 'lock-closed'}
                      size={13}
                      color={isUnlocked ? '#fbbf24' : '#94a3b8'}
                    />
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: '600',
                        color: isUnlocked ? '#fbbf24' : '#cbd5e1',
                      }}
                    >
                      {isUnlocked ? 'RELAY TERBUKA' : 'TERKUNCI'}
                    </Text>
                  </View>
                </View>

                <View style={styles.actionRow}>
                  <Pressable
                    onPress={() => handleOpenDoor(door)}
                    disabled={isBusy || !canWrite || door.mode === 'LOCKDOWN'}
                    style={({ pressed }) => [
                      styles.primaryBtn,
                      pressed && { opacity: 0.85 },
                      (isBusy || !canWrite || door.mode === 'LOCKDOWN') && { opacity: 0.45 },
                    ]}
                  >
                    {isBusy ? (
                      <ActivityIndicator color="#052e16" size="small" />
                    ) : (
                      <>
                        <Ionicons
                          name={biometricEnabled ? 'finger-print' : 'lock-open-outline'}
                          size={18}
                          color="#052e16"
                        />
                        <Text style={styles.primaryBtnText}>Buka Pintu</Text>
                      </>
                    )}
                  </Pressable>

                  <Pressable
                    onPress={() => onOpenLiveFace(door.id)}
                    disabled={isBusy || !canWrite || door.mode === 'LOCKDOWN'}
                    style={({ pressed }) => [
                      styles.faceBtn,
                      pressed && { opacity: 0.8 },
                      (isBusy || !canWrite || door.mode === 'LOCKDOWN') && { opacity: 0.45 },
                    ]}
                  >
                    <Ionicons name="scan-outline" size={18} color="#93c5fd" />
                    <Text style={styles.faceBtnText}>Live Face</Text>
                  </Pressable>
                </View>

                <View style={styles.modeRow}>
                  {(['NORMAL', 'HOLD_OPEN', 'LOCKDOWN'] as DoorMode[]).map((m) => {
                    const active = door.mode === m;
                    const lbl =
                      m === 'NORMAL'
                        ? 'Normal'
                        : m === 'HOLD_OPEN'
                          ? 'Buka Terus'
                          : 'Lockdown';
                    return (
                      <Pressable
                        key={m}
                        onPress={() => handleModeChange(door, m)}
                        disabled={isBusy || !canWrite}
                        style={[
                          styles.modeBtn,
                          active && styles.modeBtnActive,
                          m === 'LOCKDOWN' && active && styles.modeBtnLockdown,
                        ]}
                      >
                        <Text
                          style={[
                            styles.modeBtnText,
                            active && { color: '#f8fafc', fontWeight: '700' },
                          ]}
                        >
                          {lbl}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {canWrite ? (
                  <View style={styles.extraRow}>
                    <Pressable
                      onPress={() => {
                        setTapModalDoor(door);
                        setTapUid('');
                      }}
                      style={styles.extraBtn}
                    >
                      <Ionicons name="card-outline" size={14} color="#cbd5e1" />
                      <Text style={styles.extraText}>Simulasi Tap</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleDeleteDoor(door)}
                      style={styles.extraBtn}
                    >
                      <Ionicons name="trash-outline" size={14} color="#fca5a5" />
                      <Text style={[styles.extraText, { color: '#fca5a5' }]}>Hapus</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Modal Tambah Pintu */}
      <Modal visible={doorModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Tambah / Edit Pintu</Text>
            <TextInput
              style={styles.input}
              value={doorIdInput}
              onChangeText={setDoorIdInput}
              placeholder="ID Pintu (misal: pintu-gudang)"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
            />
            <TextInput
              style={styles.input}
              value={doorNameInput}
              onChangeText={setDoorNameInput}
              placeholder="Nama Pintu (misal: Pintu Gudang)"
              placeholderTextColor="#64748b"
            />
            <View style={styles.segRow}>
              {(['ESP32_CP2102', 'ESP32_S3'] as const).map((b) => (
                <Pressable
                  key={b}
                  onPress={() => setDoorBoard(b)}
                  style={[styles.segBtn, doorBoard === b && styles.segBtnActive]}
                >
                  <Text style={{ color: '#f8fafc', fontSize: 12, fontWeight: '600' }}>
                    {b === 'ESP32_S3' ? 'ESP32-S3' : 'ESP32 CP2102'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={styles.input}
              value={doorDurSec}
              onChangeText={setDoorDurSec}
              placeholder="Durasi buka (detik)"
              placeholderTextColor="#64748b"
              keyboardType="number-pad"
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setDoorModal(false)} style={styles.cancelBtn}>
                <Text style={{ color: '#cbd5e1', fontWeight: '600' }}>Batal</Text>
              </Pressable>
              <Pressable onPress={handleSaveDoor} disabled={savingDoor} style={styles.saveBtn}>
                <Text style={{ color: '#052e16', fontWeight: '700' }}>
                  {savingDoor ? 'Menyimpan...' : 'Simpan'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal Simulasi Tap */}
      <Modal visible={Boolean(tapModalDoor)} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              Simulasi Tap Kartu — {tapModalDoor?.name}
            </Text>
            <TextInput
              style={styles.input}
              value={tapUid}
              onChangeText={setTapUid}
              placeholder="Masukkan UID Kartu"
              placeholderTextColor="#64748b"
              autoCapitalize="characters"
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setTapModalDoor(null)} style={styles.cancelBtn}>
                <Text style={{ color: '#cbd5e1', fontWeight: '600' }}>Batal</Text>
              </Pressable>
              <Pressable onPress={handleSimulateTap} style={styles.saveBtn}>
                <Text style={{ color: '#052e16', fontWeight: '700' }}>Kirim Tap</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { flex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  summaryRow: { flexDirection: 'row', gap: 10 },
  summaryCard: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f2937',
    paddingVertical: 11,
    alignItems: 'center',
  },
  summaryNum: { fontSize: 20, fontWeight: '700', color: '#f8fafc' },
  summaryLbl: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  bulkBar: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  bulkBtn: {
    flex: 1,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
    borderRadius: 9,
    paddingVertical: 8,
    alignItems: 'center',
  },
  bulkText: { fontSize: 11, fontWeight: '600', color: '#cbd5e1' },
  addDoorPill: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyBox: {
    backgroundColor: '#111827',
    borderRadius: 14,
    padding: 28,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: { color: '#94a3b8', fontSize: 13 },
  doorCard: {
    backgroundColor: '#111827',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
    padding: 15,
    gap: 11,
  },
  doorHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  doorName: { fontSize: 16, fontWeight: '700', color: '#f8fafc' },
  doorMeta: { fontSize: 11.5, color: '#94a3b8', marginTop: 2 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 10.5, fontWeight: '700' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeBadge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  modeBadgeText: { fontSize: 11, fontWeight: '700' },
  relayBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  actionRow: { flexDirection: 'row', gap: 10 },
  primaryBtn: {
    flex: 1.3,
    backgroundColor: '#10b981',
    borderRadius: 11,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  primaryBtnText: { color: '#052e16', fontWeight: '700', fontSize: 14 },
  faceBtn: {
    flex: 1,
    backgroundColor: 'rgba(59, 130, 246, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.4)',
    borderRadius: 11,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  faceBtnText: { color: '#93c5fd', fontWeight: '600', fontSize: 13 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeBtn: {
    flex: 1,
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#1f2937',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  modeBtnActive: { backgroundColor: '#1e293b', borderColor: '#38bdf8' },
  modeBtnLockdown: { backgroundColor: 'rgba(239, 68, 68, 0.2)', borderColor: '#ef4444' },
  modeBtnText: { fontSize: 11.5, color: '#94a3b8' },
  extraRow: { flexDirection: 'row', gap: 8, paddingTop: 2 },
  extraBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  extraText: { fontSize: 11.5, color: '#cbd5e1', fontWeight: '600' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#111827',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 18,
    gap: 12,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#f8fafc' },
  input: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    color: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  segRow: { flexDirection: 'row', gap: 8 },
  segBtn: {
    flex: 1,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0b1220',
    paddingVertical: 9,
    alignItems: 'center',
  },
  segBtnActive: { borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.16)' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  cancelBtn: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 11,
    alignItems: 'center',
  },
  saveBtn: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: '#10b981',
    paddingVertical: 11,
    alignItems: 'center',
  },
});
