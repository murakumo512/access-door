import React, { useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AccessLogItem } from '../types';

interface Props {
  logs: AccessLogItem[];
  refreshing: boolean;
  onRefresh: () => void;
}

export function LogsScreen({ logs, refreshing, onRefresh }: Props) {
  const [filter, setFilter] = useState<'ALL' | 'GRANTED' | 'DENIED'>('ALL');

  const filtered = useMemo(() => {
    if (filter === 'ALL') return logs;
    if (filter === 'GRANTED') return logs.filter((l) => l.status === 'GRANTED');
    return logs.filter((l) => l.status === 'DENIED' || l.status === 'ALERT');
  }, [logs, filter]);

  function formatTime(ts: number) {
    const d = new Date(ts);
    return d.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  return (
    <View style={styles.flex}>
      <View style={styles.filterRow}>
        {(['ALL', 'GRANTED', 'DENIED'] as const).map((f) => {
          const active = filter === f;
          const lbl = f === 'ALL' ? 'Semua' : f === 'GRANTED' ? 'Diterima' : 'Ditolak / Alert';
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              style={[styles.filterPill, active && styles.filterPillActive]}
            >
              <Text style={[styles.filterText, active && { color: '#f8fafc' }]}>
                {lbl}
              </Text>
            </Pressable>
          );
        })}
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
        {filtered.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="document-text-outline" size={30} color="#64748b" />
            <Text style={styles.emptyText}>Belum ada log aktivitas.</Text>
          </View>
        ) : (
          filtered.slice(0, 60).map((item) => {
            const isOk = item.status === 'GRANTED';
            const isBad = item.status === 'DENIED' || item.status === 'ALERT';
            const color = isOk ? '#34d399' : isBad ? '#fca5a5' : '#93c5fd';
            const icon = isOk
              ? 'checkmark-circle'
              : isBad
                ? 'close-circle'
                : 'information-circle';

            return (
              <View key={item.id} style={styles.logCard}>
                <Ionicons name={icon} size={20} color={color} />
                <View style={{ flex: 1 }}>
                  <View style={styles.topLine}>
                    <Text style={styles.actor} numberOfLines={1}>
                      {item.actorName || item.cardUid || item.eventType}
                    </Text>
                    <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
                  </View>
                  <Text style={styles.detail}>
                    {item.doorName || item.doorId} · {item.details || item.eventType}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  filterPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  filterPillActive: {
    backgroundColor: '#1e293b',
    borderColor: '#10b981',
  },
  filterText: { fontSize: 12, fontWeight: '600', color: '#94a3b8' },
  content: { padding: 16, gap: 10, paddingBottom: 30 },
  empty: { alignItems: 'center', padding: 36, gap: 8 },
  emptyText: { color: '#94a3b8', fontSize: 13 },
  logCard: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    backgroundColor: '#111827',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f2937',
    padding: 12,
  },
  topLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  actor: { fontSize: 13.5, fontWeight: '700', color: '#f8fafc', flex: 1 },
  time: { fontSize: 11, color: '#64748b', fontVariant: ['tabular-nums'] },
  detail: { fontSize: 12, color: '#94a3b8', marginTop: 3 },
});
