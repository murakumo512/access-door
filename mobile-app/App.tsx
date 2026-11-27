import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  clearAuthSession,
  DEFAULT_SERVER_URL,
  fetchAdminState,
  getSavedConfig,
  saveBiometricPref,
} from './src/api';
import { AdminStatePayload } from './src/types';
import { LoginScreen } from './src/screens/LoginScreen';
import { DoorsScreen } from './src/screens/DoorsScreen';
import { LogsScreen } from './src/screens/LogsScreen';
import { CardsScreen } from './src/screens/CardsScreen';
import { FacesScreen } from './src/screens/FacesScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { LiveFaceUnlockModal } from './src/components/LiveFaceUnlockModal';

type TabKey = 'doors' | 'faces' | 'logs' | 'cards' | 'settings';

function MainApp() {
  const [booting, setBooting] = useState(true);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [token, setToken] = useState<string | null>(null);
  const [biometricEnabled, setBiometricEnabled] = useState(true);
  const [stateData, setStateData] = useState<AdminStatePayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabKey>('doors');
  const [syncError, setSyncError] = useState('');
  const [liveFaceModalOpen, setLiveFaceModalOpen] = useState(false);
  const [liveFaceDoorId, setLiveFaceDoorId] = useState<string | undefined>(undefined);

  const loadState = useCallback(
    async (url: string, tok: string, showSpinner = false) => {
      if (showSpinner) setRefreshing(true);
      try {
        const data = await fetchAdminState(url, tok);
        setStateData(data);
        setSyncError('');
      } catch (err: any) {
        const msg = err?.message || 'Gagal sinkronisasi';
        if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
          await clearAuthSession();
          setToken(null);
          setStateData(null);
        } else {
          setSyncError(msg);
        }
      } finally {
        if (showSpinner) setRefreshing(false);
      }
    },
    []
  );

  useEffect(() => {
    (async () => {
      const cfg = await getSavedConfig();
      setServerUrl(cfg.serverUrl);
      setBiometricEnabled(cfg.biometricEnabled);
      if (cfg.token) {
        setToken(cfg.token);
        await loadState(cfg.serverUrl, cfg.token);
      }
      setBooting(false);
    })();
  }, [loadState]);

  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => {
      loadState(serverUrl, token, false);
    }, 5000);
    return () => clearInterval(timer);
  }, [token, serverUrl, loadState]);

  async function handleLoginSuccess(url: string, newToken: string) {
    setServerUrl(url);
    setToken(newToken);
    await loadState(url, newToken, true);
  }

  async function handleLogout() {
    await clearAuthSession();
    setToken(null);
    setStateData(null);
    setTab('doors');
  }

  async function handleToggleBiometric(val: boolean) {
    setBiometricEnabled(val);
    await saveBiometricPref(val);
  }

  if (booting) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#10b981" />
        <Text style={styles.bootText}>Memuat Access Door Control...</Text>
      </View>
    );
  }

  if (!token || !stateData) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" />
        <LoginScreen
          initialServerUrl={serverUrl}
          onLoginSuccess={handleLoginSuccess}
        />
      </SafeAreaView>
    );
  }

  const doorsList = Object.values(stateData.doors || {});
  const pageTitle =
    tab === 'doors'
      ? 'Kontrol Pintu'
      : tab === 'faces'
        ? 'Wajah & Face Unlock'
        : tab === 'logs'
          ? 'Log Aktivitas'
          : tab === 'cards'
            ? 'Daftar Kartu'
            : 'Pengaturan & SDN';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topTitle}>{pageTitle}</Text>
          <Text style={styles.topSub}>
            {stateData.currentUser.name} · {stateData.currentUser.role}
          </Text>
        </View>
        <Pressable
          onPress={() => loadState(serverUrl, token, true)}
          style={styles.refreshBtn}
        >
          <Ionicons name="refresh" size={18} color="#cbd5e1" />
        </Pressable>
      </View>

      {syncError ? (
        <View style={styles.warnBanner}>
          <Text style={styles.warnText}>Koneksi tertunda: {syncError}</Text>
        </View>
      ) : null}

      <View style={styles.body}>
        {tab === 'doors' ? (
          <DoorsScreen
            serverUrl={serverUrl}
            token={token}
            user={stateData.currentUser}
            doors={doorsList}
            sites={stateData.sites || {}}
            biometricEnabled={biometricEnabled}
            refreshing={refreshing}
            onRefresh={() => loadState(serverUrl, token, true)}
            onOpenLiveFace={(dId) => {
              setLiveFaceDoorId(dId);
              setLiveFaceModalOpen(true);
            }}
          />
        ) : tab === 'faces' ? (
          <FacesScreen
            serverUrl={serverUrl}
            token={token}
            user={stateData.currentUser}
            faces={stateData.faces || []}
            doors={doorsList}
            refreshing={refreshing}
            onRefresh={() => loadState(serverUrl, token, true)}
            onOpenLiveUnlock={() => {
              setLiveFaceDoorId(doorsList[0]?.id);
              setLiveFaceModalOpen(true);
            }}
          />
        ) : tab === 'logs' ? (
          <LogsScreen
            logs={stateData.logs || []}
            refreshing={refreshing}
            onRefresh={() => loadState(serverUrl, token, true)}
          />
        ) : tab === 'cards' ? (
          <CardsScreen
            serverUrl={serverUrl}
            token={token}
            user={stateData.currentUser}
            cards={stateData.cards || []}
            doors={doorsList}
            refreshing={refreshing}
            onRefresh={() => loadState(serverUrl, token, true)}
          />
        ) : (
          <SettingsScreen
            serverUrl={serverUrl}
            token={token}
            user={stateData.currentUser}
            policy={stateData.sdnStandardPolicy}
            doors={doorsList}
            sites={stateData.sites || {}}
            admins={stateData.admins || []}
            biometricEnabled={biometricEnabled}
            onToggleBiometric={handleToggleBiometric}
            onRefresh={() => loadState(serverUrl, token, true)}
            onLogout={handleLogout}
          />
        )}
      </View>

      <View style={styles.tabBar}>
        {(
          [
            { key: 'doors', label: 'Pintu', icon: 'lock-open-outline' },
            { key: 'faces', label: 'Wajah', icon: 'scan-outline' },
            { key: 'logs', label: 'Log', icon: 'list-outline' },
            { key: 'cards', label: 'Kartu', icon: 'card-outline' },
            { key: 'settings', label: 'Admin', icon: 'settings-outline' },
          ] as const
        ).map((item) => {
          const active = tab === item.key;
          return (
            <Pressable
              key={item.key}
              onPress={() => setTab(item.key)}
              style={styles.tabItem}
            >
              <Ionicons
                name={item.icon}
                size={20}
                color={active ? '#10b981' : '#64748b'}
              />
              <Text
                style={[
                  styles.tabLabel,
                  active && { color: '#10b981', fontWeight: '700' },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <LiveFaceUnlockModal
        visible={liveFaceModalOpen}
        serverUrl={serverUrl}
        token={token}
        doors={doorsList}
        initialDoorId={liveFaceDoorId}
        onClose={() => setLiveFaceModalOpen(false)}
        onUnlocked={() => loadState(serverUrl, token, false)}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#090d16' },
  center: {
    flex: 1,
    backgroundColor: '#090d16',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  bootText: { color: '#94a3b8', fontSize: 13 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
    backgroundColor: '#0b1120',
  },
  topTitle: { fontSize: 18, fontWeight: '700', color: '#f8fafc' },
  topSub: { fontSize: 11.5, color: '#94a3b8', marginTop: 1 },
  refreshBtn: {
    padding: 8,
    borderRadius: 10,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  warnBanner: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  warnText: { color: '#fbbf24', fontSize: 12 },
  body: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#1f2937',
    backgroundColor: '#0b1120',
    paddingVertical: 8,
  },
  tabItem: { flex: 1, alignItems: 'center', gap: 3 },
  tabLabel: { fontSize: 10.5, color: '#64748b' },
});
