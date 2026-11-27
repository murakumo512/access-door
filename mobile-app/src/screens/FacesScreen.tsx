import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Ionicons } from '@expo/vector-icons';
import { createFace, deleteFace, updateFace } from '../api';
import { AdminUser, DoorInfo, FaceItem } from '../types';

interface Props {
  serverUrl: string;
  token: string;
  user: AdminUser;
  faces: FaceItem[];
  doors: DoorInfo[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpenLiveUnlock: () => void;
}

export function FacesScreen({
  serverUrl,
  token,
  user,
  faces,
  doors,
  refreshing,
  onRefresh,
  onOpenLiveUnlock,
}: Props) {
  const canWrite = user.accessMode !== 'READ_ONLY';
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<FaceItem | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('Staff');
  const [active, setActive] = useState(true);
  const [defaultPolicy, setDefaultPolicy] = useState<'PERMIT' | 'DENY'>('DENY');
  const [doorRules, setDoorRules] = useState<Record<string, 'PERMIT' | 'DENY'>>({});
  const [photoBase64, setPhotoBase64] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  function openAdd() {
    setEditing(null);
    setName('');
    setRole('Staff');
    setActive(true);
    setDefaultPolicy('PERMIT');
    setDoorRules({});
    setPhotoBase64(undefined);
    setModalOpen(true);
  }

  function openEdit(f: FaceItem) {
    setEditing(f);
    setName(f.name);
    setRole(f.role || 'Staff');
    setActive(f.active !== false);
    setDefaultPolicy(f.defaultPolicy || 'DENY');
    setDoorRules({ ...(f.doorRules || {}) });
    setPhotoBase64(f.photoBase64);
    setModalOpen(true);
  }

  async function pickPhoto(useCamera: boolean) {
    if (useCamera) {
      const p = await ImagePicker.requestCameraPermissionsAsync();
      if (!p.granted) {
        Alert.alert('Izin Kamera', 'Izinkan akses kamera terlebih dahulu.');
        return;
      }
    }
    const res = useCamera
      ? await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'],
          cameraType: ImagePicker.CameraType.front,
          quality: 0.7,
        })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.7,
        });

    if (res.canceled || !res.assets?.[0]?.uri) return;
    const resized = await ImageManipulator.manipulateAsync(
      res.assets[0].uri,
      [{ resize: { width: 480 } }],
      { compress: 0.78, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    if (resized.base64) {
      setPhotoBase64(`data:image/jpeg;base64,${resized.base64}`);
    }
  }

  function cycleDoorRule(doorId: string) {
    const curr = doorRules[doorId];
    const next = { ...doorRules };
    if (!curr) next[doorId] = 'PERMIT';
    else if (curr === 'PERMIT') next[doorId] = 'DENY';
    else delete next[doorId];
    setDoorRules(next);
  }

  async function handleSave() {
    if (!name.trim()) {
      Alert.alert('Validasi', 'Nama pemilik wajah wajib diisi.');
      return;
    }
    if (!editing && !photoBase64) {
      Alert.alert('Validasi', 'Ambil atau pilih foto wajah terlebih dahulu.');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateFace(serverUrl, token, editing.id, {
          name: name.trim(),
          role: role.trim() || 'Staff',
          active,
          defaultPolicy,
          doorRules,
          photoBase64: photoBase64 !== editing.photoBase64 ? photoBase64 : undefined,
        });
      } else {
        await createFace(serverUrl, token, {
          name: name.trim(),
          role: role.trim() || 'Staff',
          photoBase64: photoBase64!,
          defaultPolicy,
          doorRules,
        });
      }
      setModalOpen(false);
      onRefresh();
    } catch (err: any) {
      Alert.alert('Gagal', err?.message || 'Tidak bisa menyimpan data wajah.');
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(f: FaceItem) {
    Alert.alert('Hapus Wajah', `Hapus data wajah "${f.name}" dari DB?`, [
      { text: 'Batal', style: 'cancel' },
      {
        text: 'Hapus',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteFace(serverUrl, token, f.id);
            onRefresh();
          } catch (err: any) {
            Alert.alert('Gagal', err?.message || 'Gagal menghapus wajah.');
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.flex}>
      <View style={styles.topActions}>
        <Pressable onPress={onOpenLiveUnlock} style={styles.liveBtn}>
          <Ionicons name="scan-outline" size={16} color="#93c5fd" />
          <Text style={styles.liveBtnText}>Live Face Unlock</Text>
        </Pressable>
        {canWrite ? (
          <Pressable onPress={openAdd} style={styles.addBtn}>
            <Ionicons name="person-add-outline" size={16} color="#052e16" />
            <Text style={styles.addBtnText}>Daftar Wajah</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#10b981"
          />
        }
      >
        {faces.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="happy-outline" size={32} color="#64748b" />
            <Text style={styles.emptyText}>Belum ada wajah terdaftar di DB Access Door.</Text>
          </View>
        ) : (
          faces.map((f) => (
            <View key={f.id} style={styles.card}>
              {f.photoBase64 ? (
                <Image source={{ uri: f.photoBase64 }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarPlaceholder]}>
                  <Ionicons name="person" size={22} color="#64748b" />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{f.name}</Text>
                <Text style={styles.meta}>
                  {f.role || 'Staff'} · Default: {f.defaultPolicy} ·{' '}
                  {f.active !== false ? 'Aktif' : 'Nonaktif'}
                </Text>
                <View style={styles.rulesRow}>
                  {Object.entries(f.doorRules || {}).map(([dId, rule]) => (
                    <View
                      key={dId}
                      style={[
                        styles.rulePill,
                        {
                          borderColor: rule === 'PERMIT' ? '#10b981' : '#ef4444',
                          backgroundColor:
                            rule === 'PERMIT'
                              ? 'rgba(16,185,129,0.14)'
                              : 'rgba(239,68,68,0.14)',
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontSize: 10,
                          fontWeight: '700',
                          color: rule === 'PERMIT' ? '#34d399' : '#fca5a5',
                        }}
                      >
                        {dId}: {rule}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
              {canWrite ? (
                <View style={styles.rowBtns}>
                  <Pressable onPress={() => openEdit(f)} style={styles.iconBtn}>
                    <Ionicons name="create-outline" size={18} color="#93c5fd" />
                  </Pressable>
                  <Pressable onPress={() => confirmDelete(f)} style={styles.iconBtn}>
                    <Ionicons name="trash-outline" size={18} color="#fca5a5" />
                  </Pressable>
                </View>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>

      <Modal visible={modalOpen} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <ScrollView contentContainerStyle={styles.modalScroll}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                {editing ? `Edit Wajah: ${editing.name}` : 'Daftarkan Wajah Baru'}
              </Text>

              <View style={styles.photoRow}>
                {photoBase64 ? (
                  <Image source={{ uri: photoBase64 }} style={styles.previewImg} />
                ) : (
                  <View style={[styles.previewImg, styles.avatarPlaceholder]}>
                    <Ionicons name="person-outline" size={28} color="#64748b" />
                  </View>
                )}
                <View style={{ flex: 1, gap: 8 }}>
                  <Pressable onPress={() => pickPhoto(true)} style={styles.photoBtn}>
                    <Ionicons name="camera-outline" size={16} color="#f8fafc" />
                    <Text style={styles.photoBtnText}>Ambil Foto Kamera</Text>
                  </Pressable>
                  <Pressable onPress={() => pickPhoto(false)} style={styles.photoBtn}>
                    <Ionicons name="images-outline" size={16} color="#f8fafc" />
                    <Text style={styles.photoBtnText}>Pilih dari Galeri</Text>
                  </Pressable>
                </View>
              </View>

              <Text style={styles.label}>Nama Lengkap</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="Nama Pemilik Wajah"
                placeholderTextColor="#64748b"
              />

              <Text style={styles.label}>Role / Jabatan</Text>
              <TextInput
                style={styles.input}
                value={role}
                onChangeText={setRole}
                placeholder="Staff / Manager / Tamu"
                placeholderTextColor="#64748b"
              />

              <Text style={styles.label}>Kebijakan Default Pintu</Text>
              <View style={styles.segRow}>
                {(['PERMIT', 'DENY'] as const).map((pol) => (
                  <Pressable
                    key={pol}
                    onPress={() => setDefaultPolicy(pol)}
                    style={[
                      styles.segBtn,
                      defaultPolicy === pol && {
                        borderColor: pol === 'PERMIT' ? '#10b981' : '#ef4444',
                        backgroundColor:
                          pol === 'PERMIT'
                            ? 'rgba(16,185,129,0.18)'
                            : 'rgba(239,68,68,0.18)',
                      },
                    ]}
                  >
                    <Text style={{ color: '#f8fafc', fontWeight: '700', fontSize: 12 }}>
                      {pol}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.label}>Aturan Khusus Per Pintu (Tap untuk ubah)</Text>
              <View style={styles.rulesWrap}>
                {doors.map((d) => {
                  const val = doorRules[d.id] || 'DEFAULT';
                  return (
                    <Pressable
                      key={d.id}
                      onPress={() => cycleDoorRule(d.id)}
                      style={styles.doorRuleChip}
                    >
                      <Text style={{ color: '#cbd5e1', fontSize: 12 }}>
                        {d.name}:{' '}
                        <Text
                          style={{
                            fontWeight: '700',
                            color:
                              val === 'PERMIT'
                                ? '#34d399'
                                : val === 'DENY'
                                  ? '#fca5a5'
                                  : '#94a3b8',
                          }}
                        >
                          {val}
                        </Text>
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {editing ? (
                <View style={styles.switchRow}>
                  <Text style={{ color: '#cbd5e1', fontSize: 13 }}>Status Aktif</Text>
                  <Switch
                    value={active}
                    onValueChange={setActive}
                    trackColor={{ false: '#334155', true: '#10b981' }}
                  />
                </View>
              ) : null}

              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => setModalOpen(false)}
                  style={styles.cancelBtn}
                >
                  <Text style={{ color: '#cbd5e1', fontWeight: '600' }}>Batal</Text>
                </Pressable>
                <Pressable
                  onPress={handleSave}
                  disabled={saving}
                  style={styles.saveBtn}
                >
                  {saving ? (
                    <ActivityIndicator color="#052e16" size="small" />
                  ) : (
                    <Text style={{ color: '#052e16', fontWeight: '700' }}>Simpan</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topActions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  liveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(59,130,246,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.4)',
    borderRadius: 10,
    paddingVertical: 9,
  },
  liveBtnText: { color: '#93c5fd', fontWeight: '700', fontSize: 12.5 },
  addBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#10b981',
    borderRadius: 10,
    paddingVertical: 9,
  },
  addBtnText: { color: '#052e16', fontWeight: '700', fontSize: 12.5 },
  content: { padding: 16, gap: 10, paddingBottom: 32 },
  emptyBox: { alignItems: 'center', padding: 36, gap: 8 },
  emptyText: { color: '#94a3b8', fontSize: 13, textAlign: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#111827',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1f2937',
    padding: 12,
  },
  avatar: { width: 52, height: 52, borderRadius: 12 },
  avatarPlaceholder: {
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 14.5, fontWeight: '700', color: '#f8fafc' },
  meta: { fontSize: 11.5, color: '#94a3b8', marginTop: 2 },
  rulesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 },
  rulePill: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  rowBtns: { flexDirection: 'row', gap: 4 },
  iconBtn: { padding: 6 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)' },
  modalScroll: { flexGrow: 1, justifyContent: 'center', padding: 18 },
  modalCard: {
    backgroundColor: '#111827',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 18,
    gap: 10,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#f8fafc' },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  previewImg: { width: 76, height: 76, borderRadius: 14 },
  photoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#1e293b',
    borderRadius: 9,
    paddingVertical: 9,
  },
  photoBtnText: { color: '#f8fafc', fontSize: 12.5, fontWeight: '600' },
  label: { color: '#cbd5e1', fontSize: 12, fontWeight: '600', marginTop: 4 },
  input: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    color: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13.5,
  },
  segRow: { flexDirection: 'row', gap: 10 },
  segBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0b1220',
    borderRadius: 9,
    paddingVertical: 9,
    alignItems: 'center',
  },
  rulesWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  doorRuleChip: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
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
