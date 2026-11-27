import React, { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  deleteAdminUser,
  deleteSite,
  saveSdnPolicy,
  upsertAdminUser,
  upsertSite,
} from '../api';
import { AdminUser, DoorInfo, SdnPolicy, SiteInfo } from '../types';

interface Props {
  serverUrl: string;
  token: string;
  user: AdminUser;
  policy?: SdnPolicy;
  doors: DoorInfo[];
  sites: Record<string, SiteInfo>;
  admins: AdminUser[];
  biometricEnabled: boolean;
  onToggleBiometric: (val: boolean) => void;
  onRefresh: () => void;
  onLogout: () => void;
}

export function SettingsScreen({
  serverUrl,
  token,
  user,
  policy,
  sites,
  admins,
  biometricEnabled,
  onToggleBiometric,
  onRefresh,
  onLogout,
}: Props) {
  const canWrite = user.accessMode !== 'READ_ONLY';
  const isSuper = user.role === 'SUPER_ADMIN';

  // SDN Policy state
  const [antiBf, setAntiBf] = useState(policy?.antiBruteforce ?? true);
  const [maxFails, setMaxFails] = useState(String(policy?.bruteforceMaxFails ?? 5));
  const [lockoutSec, setLockoutSec] = useState(String(policy?.lockoutDurationSec ?? 15));
  const [cooldownMs, setCooldownMs] = useState(String(policy?.sameCardCooldownMs ?? 2000));
  const [exitInLockdown, setExitInLockdown] = useState(policy?.exitInLockdown ?? false);
  const [buzzerEnabled, setBuzzerEnabled] = useState(policy?.buzzerEnabled ?? true);
  const [savingPolicy, setSavingPolicy] = useState(false);

  // Site Modal
  const [siteModal, setSiteModal] = useState(false);
  const [siteId, setSiteId] = useState('');
  const [siteName, setSiteName] = useState('');

  // User Modal
  const [userModal, setUserModal] = useState(false);
  const [uUsername, setUUsername] = useState('');
  const [uPassword, setUPassword] = useState('');
  const [uName, setUName] = useState('');
  const [uRole, setURole] = useState<'SITE_ADMIN' | 'VIEWER' | 'SUPER_ADMIN'>('SITE_ADMIN');
  const [uAccessMode, setUAccessMode] = useState<'READ_WRITE' | 'READ_ONLY'>('READ_WRITE');

  useEffect(() => {
    if (policy) {
      setAntiBf(policy.antiBruteforce);
      setMaxFails(String(policy.bruteforceMaxFails));
      setLockoutSec(String(policy.lockoutDurationSec));
      setCooldownMs(String(policy.sameCardCooldownMs));
      setExitInLockdown(policy.exitInLockdown);
      setBuzzerEnabled(policy.buzzerEnabled);
    }
  }, [policy?.version]);

  async function handleSavePolicy() {
    setSavingPolicy(true);
    try {
      await saveSdnPolicy(serverUrl, token, {
        targetMode: 'ALL',
        targetDoors: [],
        policy: {
          antiBruteforce: antiBf,
          bruteforceMaxFails: Number(maxFails) || 5,
          lockoutDurationSec: Number(lockoutSec) || 15,
          sameCardCooldownMs: Number(cooldownMs) || 2000,
          exitInLockdown,
          buzzerEnabled,
        },
      });
      Alert.alert('Berhasil', 'SDN Policy disimpan dan dikirim ke semua ESP32.');
      onRefresh();
    } catch (err: any) {
      Alert.alert('Gagal', err?.message || 'Gagal menyimpan SDN Policy.');
    } finally {
      setSavingPolicy(false);
    }
  }

  async function handleSaveSite() {
    if (!siteId.trim() || !siteName.trim()) {
      Alert.alert('Validasi', 'Kode Site dan Nama Site wajib diisi.');
      return;
    }
    try {
      await upsertSite(serverUrl, token, { id: siteId.trim(), name: siteName.trim() });
      setSiteModal(false);
      setSiteId('');
      setSiteName('');
      onRefresh();
    } catch (err: any) {
      Alert.alert('Gagal', err?.message || 'Gagal menyimpan site.');
    }
  }

  async function handleSaveUser() {
    if (!uUsername.trim() || !uName.trim()) {
      Alert.alert('Validasi', 'Username dan Nama wajib diisi.');
      return;
    }
    const finalMode =
      uRole === 'SUPER_ADMIN'
        ? 'READ_WRITE'
        : uRole === 'VIEWER'
          ? 'READ_ONLY'
          : uAccessMode;
    try {
      await upsertAdminUser(serverUrl, token, {
        username: uUsername.trim(),
        password: uPassword || undefined,
        name: uName.trim(),
        role: uRole,
        accessMode: finalMode,
        allowedSites: ['*'],
      });
      setUserModal(false);
      setUUsername('');
      setUPassword('');
      setUName('');
      onRefresh();
    } catch (err: any) {
      Alert.alert('Gagal', err?.message || 'Gagal menyimpan akun.');
    }
  }

  function confirmLogout() {
    Alert.alert('Keluar Akun', 'Yakin ingin logout dari aplikasi?', [
      { text: 'Batal', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: onLogout },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {/* Profil User */}
      <View style={styles.card}>
        <View style={styles.userRow}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={24} color="#10b981" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{user.name}</Text>
            <Text style={styles.meta}>
              @{user.username} · {user.role} ({user.accessMode})
            </Text>
          </View>
        </View>
      </View>

      {/* Keamanan HP & Server */}
      <View style={styles.card}>
        <View style={styles.settingRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingTitle}>Kunci Biometrik (Face ID / Sidik Jari)</Text>
            <Text style={styles.settingSub}>
              Minta verifikasi biometrik HP sebelum membuka pintu atau mengubah mode.
            </Text>
          </View>
          <Switch
            value={biometricEnabled}
            onValueChange={onToggleBiometric}
            trackColor={{ false: '#334155', true: '#10b981' }}
            thumbColor="#f8fafc"
          />
        </View>
        <View style={styles.divider} />
        <View>
          <Text style={styles.settingTitle}>Server Terhubung</Text>
          <Text style={styles.urlText}>{serverUrl}</Text>
        </View>
      </View>

      {/* SDN Runtime Policy */}
      {canWrite ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>SDN Policy Perangkat (v{policy?.version || 1})</Text>
          <View style={styles.settingRow}>
            <Text style={styles.settingSub}>Anti-Bruteforce Lockout</Text>
            <Switch value={antiBf} onValueChange={setAntiBf} trackColor={{ false: '#334155', true: '#10b981' }} />
          </View>
          <View style={styles.settingRow}>
            <Text style={styles.settingSub}>Izinkan Tombol Exit saat Lockdown</Text>
            <Switch value={exitInLockdown} onValueChange={setExitInLockdown} trackColor={{ false: '#334155', true: '#10b981' }} />
          </View>
          <View style={styles.settingRow}>
            <Text style={styles.settingSub}>Aktifkan Buzzer / Beep Reader</Text>
            <Switch value={buzzerEnabled} onValueChange={setBuzzerEnabled} trackColor={{ false: '#334155', true: '#10b981' }} />
          </View>
          <View style={styles.numGrid}>
            <View style={styles.numCell}>
              <Text style={styles.numLbl}>Max Gagal</Text>
              <TextInput style={styles.numInput} value={maxFails} onChangeText={setMaxFails} keyboardType="number-pad" />
            </View>
            <View style={styles.numCell}>
              <Text style={styles.numLbl}>Lockout (s)</Text>
              <TextInput style={styles.numInput} value={lockoutSec} onChangeText={setLockoutSec} keyboardType="number-pad" />
            </View>
            <View style={styles.numCell}>
              <Text style={styles.numLbl}>Cooldown (ms)</Text>
              <TextInput style={styles.numInput} value={cooldownMs} onChangeText={setCooldownMs} keyboardType="number-pad" />
            </View>
          </View>
          <Pressable onPress={handleSavePolicy} disabled={savingPolicy} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>
              {savingPolicy ? 'Menyimpan...' : 'Simpan & Push SDN Policy'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Super Admin: Lokasi Site & Pengguna */}
      {isSuper ? (
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Lokasi Site ({Object.keys(sites).length})</Text>
            <Pressable onPress={() => setSiteModal(true)} style={styles.miniAdd}>
              <Text style={styles.miniAddText}>+ Site</Text>
            </Pressable>
          </View>
          {Object.values(sites).map((s) => (
            <View key={s.id} style={styles.listRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{s.name}</Text>
                <Text style={styles.rowSub}>{s.id}</Text>
              </View>
              {Object.keys(sites).length > 1 ? (
                <Pressable
                  onPress={() =>
                    Alert.alert('Hapus Site', `Hapus site ${s.name}?`, [
                      { text: 'Batal', style: 'cancel' },
                      {
                        text: 'Hapus',
                        style: 'destructive',
                        onPress: async () => {
                          await deleteSite(serverUrl, token, s.id);
                          onRefresh();
                        },
                      },
                    ])
                  }
                >
                  <Ionicons name="trash-outline" size={17} color="#fca5a5" />
                </Pressable>
              ) : null}
            </View>
          ))}

          <View style={styles.divider} />

          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Akun Admin ({admins.length})</Text>
            <Pressable onPress={() => setUserModal(true)} style={styles.miniAdd}>
              <Text style={styles.miniAddText}>+ Akun</Text>
            </Pressable>
          </View>
          {admins.map((a) => (
            <View key={a.username} style={styles.listRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{a.name} (@{a.username})</Text>
                <Text style={styles.rowSub}>{a.role} · {a.accessMode}</Text>
              </View>
              {a.username !== user.username ? (
                <Pressable
                  onPress={() =>
                    Alert.alert('Hapus Akun', `Hapus akun @${a.username}?`, [
                      { text: 'Batal', style: 'cancel' },
                      {
                        text: 'Hapus',
                        style: 'destructive',
                        onPress: async () => {
                          await deleteAdminUser(serverUrl, token, a.username);
                          onRefresh();
                        },
                      },
                    ])
                  }
                >
                  <Ionicons name="trash-outline" size={17} color="#fca5a5" />
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      <Pressable
        onPress={confirmLogout}
        style={({ pressed }) => [styles.logoutBtn, pressed && { opacity: 0.85 }]}
      >
        <Ionicons name="log-out-outline" size={18} color="#fca5a5" />
        <Text style={styles.logoutText}>Keluar dari Akun</Text>
      </Pressable>

      {/* Modal Tambah Site */}
      <Modal visible={siteModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Tambah Lokasi Site</Text>
            <TextInput style={styles.input} value={siteId} onChangeText={setSiteId} placeholder="Kode Site (misal: site-cabang)" placeholderTextColor="#64748b" autoCapitalize="none" />
            <TextInput style={styles.input} value={siteName} onChangeText={setSiteName} placeholder="Nama Site" placeholderTextColor="#64748b" />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setSiteModal(false)} style={styles.cancelBtn}>
                <Text style={{ color: '#cbd5e1', fontWeight: '600' }}>Batal</Text>
              </Pressable>
              <Pressable onPress={handleSaveSite} style={styles.saveBtn}>
                <Text style={{ color: '#052e16', fontWeight: '700' }}>Simpan</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal Tambah Akun */}
      <Modal visible={userModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Tambah / Edit Akun Admin</Text>
            <TextInput style={styles.input} value={uUsername} onChangeText={setUUsername} placeholder="Username" placeholderTextColor="#64748b" autoCapitalize="none" />
            <TextInput style={styles.input} value={uName} onChangeText={setUName} placeholder="Nama Lengkap" placeholderTextColor="#64748b" />
            <TextInput style={styles.input} value={uPassword} onChangeText={setUPassword} placeholder="Password (kosongkan jika edit)" placeholderTextColor="#64748b" secureTextEntry />
            <View style={styles.segRow}>
              {(['SITE_ADMIN', 'VIEWER', 'SUPER_ADMIN'] as const).map((r) => (
                <Pressable
                  key={r}
                  onPress={() => {
                    setURole(r);
                    if (r === 'SUPER_ADMIN') setUAccessMode('READ_WRITE');
                    if (r === 'VIEWER') setUAccessMode('READ_ONLY');
                  }}
                  style={[styles.segBtn, uRole === r && styles.segBtnActive]}
                >
                  <Text style={{ color: '#f8fafc', fontSize: 10.5, fontWeight: '700' }}>
                    {r.replace('_', ' ')}
                  </Text>
                </Pressable>
              ))}
            </View>
            {uRole === 'SITE_ADMIN' ? (
              <View style={styles.segRow}>
                {(['READ_WRITE', 'READ_ONLY'] as const).map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => setUAccessMode(m)}
                    style={[styles.segBtn, uAccessMode === m && styles.segBtnActive]}
                  >
                    <Text style={{ color: '#f8fafc', fontSize: 11, fontWeight: '600' }}>{m}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={styles.modalActions}>
              <Pressable onPress={() => setUserModal(false)} style={styles.cancelBtn}>
                <Text style={{ color: '#cbd5e1', fontWeight: '600' }}>Batal</Text>
              </Pressable>
              <Pressable onPress={handleSaveUser} style={styles.saveBtn}>
                <Text style={{ color: '#052e16', fontWeight: '700' }}>Simpan</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 34 },
  card: {
    backgroundColor: '#111827',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
    padding: 16,
    gap: 12,
  },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 16, fontWeight: '700', color: '#f8fafc' },
  meta: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  settingTitle: { fontSize: 14, fontWeight: '600', color: '#f8fafc' },
  settingSub: { fontSize: 12.5, color: '#cbd5e1', flex: 1 },
  divider: { height: 1, backgroundColor: '#1f2937' },
  urlText: { fontSize: 12.5, color: '#38bdf8', marginTop: 4 },
  sectionTitle: { fontSize: 14.5, fontWeight: '700', color: '#f8fafc' },
  numGrid: { flexDirection: 'row', gap: 8 },
  numCell: { flex: 1, gap: 4 },
  numLbl: { fontSize: 11, color: '#94a3b8' },
  numInput: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    color: '#f8fafc',
    paddingVertical: 7,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '700',
  },
  primaryBtn: {
    backgroundColor: '#10b981',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#052e16', fontWeight: '700', fontSize: 13 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  miniAdd: {
    backgroundColor: 'rgba(16,185,129,0.16)',
    borderWidth: 1,
    borderColor: '#10b981',
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  miniAddText: { color: '#34d399', fontSize: 11.5, fontWeight: '700' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0b1220',
    borderRadius: 9,
    padding: 10,
  },
  rowTitle: { color: '#f8fafc', fontSize: 13, fontWeight: '600' },
  rowSub: { color: '#94a3b8', fontSize: 11 },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    borderRadius: 12,
    paddingVertical: 13,
  },
  logoutText: { color: '#fca5a5', fontWeight: '700', fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: '#111827', borderRadius: 16, borderWidth: 1, borderColor: '#334155', padding: 18, gap: 11 },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#f8fafc' },
  input: { backgroundColor: '#0b1220', borderWidth: 1, borderColor: '#334155', borderRadius: 10, color: '#f8fafc', paddingHorizontal: 12, paddingVertical: 10, fontSize: 13.5 },
  segRow: { flexDirection: 'row', gap: 6 },
  segBtn: { flex: 1, borderRadius: 8, borderWidth: 1, borderColor: '#334155', backgroundColor: '#0b1220', paddingVertical: 8, alignItems: 'center' },
  segBtnActive: { borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.16)' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  cancelBtn: { flex: 1, borderRadius: 10, borderWidth: 1, borderColor: '#334155', paddingVertical: 11, alignItems: 'center' },
  saveBtn: { flex: 1, borderRadius: 10, backgroundColor: '#10b981', paddingVertical: 11, alignItems: 'center' },
});
