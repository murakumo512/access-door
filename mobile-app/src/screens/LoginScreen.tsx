import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DEFAULT_SERVER_URL, loginAdmin, saveAuthSession } from '../api';

interface Props {
  initialServerUrl?: string;
  onLoginSuccess: (serverUrl: string, token: string) => void;
}

export function LoginScreen({ initialServerUrl, onLoginSuccess }: Props) {
  const [serverUrl, setServerUrl] = useState(initialServerUrl || DEFAULT_SERVER_URL);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleLogin() {
    if (!serverUrl.trim() || !username.trim() || !password) {
      setError('Server URL, username, dan password wajib diisi.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
      const res = await loginAdmin(cleanUrl, username.trim(), password);
      if (!res.token) {
        throw new Error('Token login tidak diterima dari server.');
      }
      await saveAuthSession(cleanUrl, res.token);
      onLoginSuccess(cleanUrl, res.token);
    } catch (err: any) {
      setError(err?.message || 'Gagal terhubung ke server.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.logoWrap}>
          <View style={styles.logoCircle}>
            <Ionicons name="shield-checkmark" size={36} color="#10b981" />
          </View>
          <Text style={styles.title}>Access Door Control</Text>
          <Text style={styles.subtitle}>
            Kendali Pintu, Face Unlock & Log Keamanan (Android & iOS)
          </Text>
        </View>

        <View style={styles.card}>
          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={18} color="#fca5a5" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Text style={styles.label}>URL Server</Text>
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="https://access-door.example.com"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="admin"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Password</Text>
          <View style={styles.passRow}>
            <TextInput
              style={[styles.input, styles.passInput]}
              value={password}
              onChangeText={setPassword}
              placeholder="Masukkan password"
              placeholderTextColor="#64748b"
              secureTextEntry={!showPass}
              autoCapitalize="none"
            />
            <Pressable
              onPress={() => setShowPass(!showPass)}
              style={styles.eyeBtn}
            >
              <Ionicons
                name={showPass ? 'eye-off' : 'eye'}
                size={20}
                color="#94a3b8"
              />
            </Pressable>
          </View>

          <Pressable
            onPress={handleLogin}
            disabled={loading}
            style={({ pressed }) => [
              styles.loginBtn,
              pressed && { opacity: 0.85 },
              loading && { opacity: 0.6 },
            ]}
          >
            {loading ? (
              <ActivityIndicator color="#052e16" />
            ) : (
              <>
                <Ionicons name="log-in-outline" size={20} color="#052e16" />
                <Text style={styles.loginBtnText}>Masuk ke Dashboard</Text>
              </>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#090d16' },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  logoWrap: {
    alignItems: 'center',
    marginBottom: 24,
  },
  logoCircle: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: '#94a3b8',
    textAlign: 'center',
  },
  card: {
    backgroundColor: '#111827',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
    padding: 18,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderColor: 'rgba(239, 68, 68, 0.4)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 14,
  },
  errorText: { color: '#fca5a5', fontSize: 12.5, flex: 1 },
  label: {
    color: '#cbd5e1',
    fontSize: 12.5,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 10,
  },
  input: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    color: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 14,
  },
  passRow: { position: 'relative', justifyContent: 'center' },
  passInput: { paddingRight: 44 },
  eyeBtn: { position: 'absolute', right: 12, padding: 4 },
  loginBtn: {
    marginTop: 20,
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loginBtnText: {
    color: '#052e16',
    fontWeight: '700',
    fontSize: 15,
  },
});
