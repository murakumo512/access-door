import React, { useMemo, useState } from 'react';
import {
  Alert,
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
import { Ionicons } from '@expo/vector-icons';
import { pushSyncCards, removeCard, upsertCard } from '../api';
import { AdminUser, DoorInfo, RfidCardItem } from '../types';

interface Props {
  serverUrl: string;
  token: string;
  user: AdminUser;
  cards: RfidCardItem[];
  doors: DoorInfo[];
  refreshing: boolean;
  onRefresh: () => void;
}

export function CardsScreen({
  serverUrl,
  token,
  user,
  cards,
  doors,
  refreshing,
  onRefresh,
}: Props) {
  const [search, setSearch] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [uid, setUid] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('Staff');
  const [durSec, setDurSec] = useState('0');
  const [active, setActive] = useState(true);
  const [allowedDoors, setAllowedDoors] = useState<string[]>(['*']);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const canWrite = user.accessMode !== 'READ_ONLY';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.uid.toLowerCase().includes(q) ||
        (c.role || '').toLowerCase().includes(q)
    );
  }, [cards, search]);

  function openAdd() {
    setUid('');
    setName('');
    setRole('Staff');
    setDurSec('0');
    setActive(true);
    setAllowedDoors(['*']);
    setModalVisible(true);
  }

  function openEdit(c: RfidCardItem) {
    setUid(c.uid);
    setName(c.name);
    setRole(c.role || 'Staff');
    setDurSec(String(Math.round((c.unlockDurationMs || 0) / 1000)));
    setActive(c.active !== false);
    setAllowedDoors(c.allowedDoors?.length ? c.allowedDoors : ['*']);
    setModalVisible(true);
  }

  function toggleDoorAllow(doorId: string) {
    if (doorId === '*') {
      setAllowedDoors(['*']);
      return;
    }
    const base = allowedDoors.filter((x) => x !== '*');
    const next = base.includes(doorId)
      ? base.filter((x) => x !== doorId)
      : [...base, doorId];
    setAllowedDoors(next.length ? next : ['*']);
  }

  async function handleSave() {
    if (!uid.trim() || !name.trim()) {
      Alert.alert('Validasi', 'UID kartu dan Nama pemegang wajib diisi.');
      return;
    }
    setSaving(true);
    try {
      await upsertCard(serverUrl, token, {
        uid: uid.trim(),
        name: name.trim(),
        role: role.trim() || 'Staff',
        active,
        allowedDoors,
        unlockDurationSeconds: Number(durSec) || 0,
      });
      setModalVisible(false);
      onRefresh();
    } catch (err: any) {
      Alert.alert('Gagal', err?.message || 'Gagal menyimpan kartu.');
    } finally {
      setSaving(false);
    }
  }

  async function handlePushSync() {
    setSyncing(true);
    try {
      await pushSyncCards(serverUrl, token);
      Alert.alert('Sinkronisasi', 'Perintah Push Sync kartu dikirim ke semua ESP32.');
      onRefresh();
    } catch (err: any) {
      Alert.alert('Gagal', err?.message || 'Gagal push sync.');
    } finally {
      setSyncing(false);
    }
  }

  function handleDelete(card: RfidCardItem) {
    if (!canWrite) return;
    Alert.alert('Hapus Kartu', `Hapus kartu milik ${card.name} (${card.uid})?`, [
      { text: 'Batal', style: 'cancel' },
      {
        text: 'Hapus',
        style: 'destructive',
        onPress: async () => {
          try {
            await removeCard(serverUrl, token, card.uid);
            onRefresh();
          } catch (err: any) {
            Alert.alert('Gagal', err?.message || 'Tidak bisa menghapus kartu.');
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.flex}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Cari nama atau UID kartu..."
          placeholderTextColor="#64748b"
        />
      </View>

      {canWrite ? (
        <View style={styles.headerBar}>
          <Pressable
            onPress={handlePushSync}
            disabled={syncing}
            style={styles.syncBtn}
          >
            <Ionicons name="sync-outline" size={16} color="#93c5fd" />
            <Text style={styles.syncBtnText}>
              {syncing ? 'Syncing...' : 'Push Sync ESP32'}
            </Text>
          </Pressable>
          <Pressable onPress={openAdd} style={styles.addBtn}>
            <Ionicons name="add" size={18} color="#052e16" />
            <Text style={styles.addBtnText}>Tambah Kartu</Text>
          </Pressable>
        </View>
      ) : null}

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
        {filtered.map((c) => (
          <View key={c.uid} style={styles.cardRow}>
            <View style={styles.iconBox}>
              <Ionicons name="card" size={20} color="#38bdf8" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardName}>{c.name}</Text>
              <Text style={styles.cardMeta}>
                UID: {c.uid} · {c.role || 'Staff'} · {c.active ? 'Aktif' : 'Nonaktif'}
              </Text>
              <Text style={styles.cardDoors}>
                Akses: {c.allowedDoors?.includes('*') ? 'Semua Pintu' : (c.allowedDoors || []).join(', ')}
              </Text>
            </View>
            {canWrite ? (
              <View style={{ flexDirection: 'row', gap: 2 }}>
                <Pressable onPress={() => openEdit(c)} style={styles.delBtn}>
                  <Ionicons name="create-outline" size={18} color="#93c5fd" />
                </Pressable>
                <Pressable onPress={() => handleDelete(c)} style={styles.delBtn}>
                  <Ionicons name="trash-outline" size={18} color="#fca5a5" />
                </Pressable>
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>

      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Simpan Kartu RFID</Text>
            <TextInput
              style={styles.input}
              value={uid}
              onChangeText={setUid}
              placeholder="UID Kartu (contoh: 12345678)"
              placeholderTextColor="#64748b"
              autoCapitalize="characters"
            />
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Nama Pemilik"
              placeholderTextColor="#64748b"
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={role}
                onChangeText={setRole}
                placeholder="Role"
                placeholderTextColor="#64748b"
              />
              <TextInput
                style={[styles.input, { width: 96 }]}
                value={durSec}
                onChangeText={setDurSec}
                placeholder="Durasi(s)"
                placeholderTextColor="#64748b"
                keyboardType="number-pad"
              />
            </View>

            <Text style={{ color: '#cbd5e1', fontSize: 12, fontWeight: '600' }}>
              Izin Pintu:
            </Text>
            <View style={styles.doorPills}>
              <Pressable
                onPress={() => toggleDoorAllow('*')}
                style={[
                  styles.doorChip,
                  allowedDoors.includes('*') && styles.doorChipActive,
                ]}
              >
                <Text style={styles.doorChipText}>Semua Pintu</Text>
              </Pressable>
              {doors.map((d) => {
                const activeChip = !allowedDoors.includes('*') && allowedDoors.includes(d.id);
                return (
                  <Pressable
                    key={d.id}
                    onPress={() => toggleDoorAllow(d.id)}
                    style={[styles.doorChip, activeChip && styles.doorChipActive]}
                  >
                    <Text style={styles.doorChipText}>{d.name}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.switchRow}>
              <Text style={{ color: '#cbd5e1', fontSize: 13 }}>Kartu Aktif</Text>
              <Switch
                value={active}
                onValueChange={setActive}
                trackColor={{ false: '#334155', true: '#10b981' }}
              />
            </View>

            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setModalVisible(false)}
                style={styles.cancelBtn}
              >
                <Text style={{ color: '#cbd5e1', fontWeight: '600' }}>Batal</Text>
              </Pressable>
              <Pressable
                onPress={handleSave}
                disabled={saving}
                style={styles.saveBtn}
              >
                <Text style={{ color: '#052e16', fontWeight: '700' }}>
                  {saving ? 'Menyimpan...' : 'Simpan'}
                </Text>
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
  searchRow: { paddingHorizontal: 16, paddingTop: 12 },
  searchInput: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
    borderRadius: 10,
    color: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
  },
  headerBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
  },
  syncBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(59,130,246,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.4)',
    paddingVertical: 9,
    borderRadius: 10,
  },
  syncBtnText: { color: '#93c5fd', fontSize: 12.5, fontWeight: '700' },
  addBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: '#10b981',
    paddingVertical: 9,
    borderRadius: 10,
  },
  addBtnText: { color: '#052e16', fontSize: 12.5, fontWeight: '700' },
  content: { padding: 16, gap: 10, paddingBottom: 30 },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#111827',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f2937',
    padding: 12,
  },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardName: { fontSize: 14, fontWeight: '700', color: '#f8fafc' },
  cardMeta: { fontSize: 11.5, color: '#94a3b8', marginTop: 2 },
  cardDoors: { fontSize: 11, color: '#64748b', marginTop: 2 },
  delBtn: { padding: 6 },
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
    gap: 11,
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
    fontSize: 13.5,
  },
  doorPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  doorChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#334155',
  },
  doorChipActive: { borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.16)' },
  doorChipText: { color: '#cbd5e1', fontSize: 11.5 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
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
