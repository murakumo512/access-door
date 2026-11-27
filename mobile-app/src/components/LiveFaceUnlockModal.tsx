import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { faceUnlockDoor } from '../api';
import { DoorInfo, FaceOverlayBox } from '../types';

interface Props {
  visible: boolean;
  serverUrl: string;
  token: string;
  doors: DoorInfo[];
  initialDoorId?: string;
  onClose: () => void;
  onUnlocked: () => void;
}

export function LiveFaceUnlockModal({
  visible,
  serverUrl,
  token,
  doors,
  initialDoorId,
  onClose,
  onUnlocked,
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);

  const [selectedDoorId, setSelectedDoorId] = useState(
    initialDoorId || doors[0]?.id || 'pintu-utama'
  );
  const [durationSec, setDurationSec] = useState('5');
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [autoScan, setAutoScan] = useState(true);
  const [pausedAfterMatch, setPausedAfterMatch] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [hudText, setHudText] = useState('Menyiapkan kamera...');
  const [banner, setBanner] = useState<{
    tone: 'info' | 'success' | 'warn' | 'danger';
    title: string;
    sub?: string;
  }>({
    tone: 'info',
    title: 'Arahkan wajah ke kamera',
    sub: 'Auto-scan aktif — sistem memverifikasi wajah secara live.',
  });
  const [boxes, setBoxes] = useState<FaceOverlayBox[]>([]);
  const [imgSize, setImgSize] = useState({ w: 480, h: 640 });
  const [previewSize, setPreviewSize] = useState({ w: 320, h: 420 });

  useEffect(() => {
    if (visible) {
      setSelectedDoorId(initialDoorId || doors[0]?.id || 'pintu-utama');
      setPausedAfterMatch(false);
      pausedRef.current = false;
      setBoxes([]);
      setBanner({
        tone: 'info',
        title: 'Arahkan wajah ke kamera',
        sub: 'Auto-scan aktif — sistem memverifikasi wajah secara live.',
      });
      if (!permission?.granted) {
        requestPermission();
      }
    }
  }, [visible, initialDoorId]);

  useEffect(() => {
    pausedRef.current = pausedAfterMatch;
  }, [pausedAfterMatch]);

  async function scanOneFrame(isManual = false) {
    if (!visible || !cameraRef.current || busyRef.current) return;
    if (!isManual && (!autoScan || pausedRef.current)) return;

    busyRef.current = true;
    if (isManual) setScanning(true);

    try {
      const pic = await cameraRef.current.takePictureAsync({
        quality: 0.4,
        skipProcessing: true,
        shutterSound: false,
      });
      if (!pic?.uri) return;

      const resized = await ImageManipulator.manipulateAsync(
        pic.uri,
        [{ resize: { width: 480 } }],
        {
          compress: 0.72,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        }
      );

      if (!resized.base64) return;
      const dataUrl = `data:image/jpeg;base64,${resized.base64}`;
      const dur = Math.max(1, Math.min(60, Number(durationSec) || 5));

      const res = await faceUnlockDoor(
        serverUrl,
        token,
        selectedDoorId,
        dataUrl,
        dur * 1000,
        isManual
      );

      setBoxes(res.faces || []);
      setImgSize({
        w: res.imageWidth || resized.width || 480,
        h: res.imageHeight || resized.height || 640,
      });
      setHudText(`${res.engine || 'YuNet+SFace'} · ${Math.round(res.inferenceMs || 0)} ms`);

      if (res.matched && res.person) {
        const p = res.person;
        if (!res.permitted) {
          setBanner({
            tone: 'danger',
            title: `Akses DITOLAK (${p.permission || 'DENY'})`,
            sub: res.error || `${p.name} tidak diizinkan di pintu ini.`,
          });
        } else if (res.lockdown) {
          setBanner({
            tone: 'danger',
            title: `${p.name} (${p.confidence}%) — LOCKDOWN`,
            sub: 'Pintu sedang dalam mode LOCKDOWN.',
          });
        } else if (res.unlocked) {
          pausedRef.current = true;
          setPausedAfterMatch(true);
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setBanner({
            tone: 'success',
            title: `Diterima: ${p.name} (${p.confidence}%)`,
            sub: `${res.doorName || selectedDoorId} dibuka ${dur} detik!`,
          });
          onUnlocked();
        }
      } else if (res.faceDetected) {
        setBanner({
          tone: 'warn',
          title: `Wajah belum terdaftar (${res.closestConfidence || 0}%)`,
          sub: 'Daftarkan wajah dulu di tab Wajah jika ingin diberi akses.',
        });
      } else {
        setBanner({
          tone: 'info',
          title: 'Mencari wajah...',
          sub: 'Pastikan wajah menghadap kamera dengan cahaya cukup.',
        });
      }
    } catch (err: any) {
      setHudText('Menunggu koneksi...');
      if (isManual) {
        setBanner({
          tone: 'danger',
          title: 'Gagal verifikasi',
          sub: err?.message || 'Tidak bisa menghubungi Face AI server.',
        });
      }
    } finally {
      busyRef.current = false;
      setScanning(false);
    }
  }

  useEffect(() => {
    if (!visible || !permission?.granted) return;
    const timer = setInterval(() => {
      scanOneFrame(false);
    }, 950);
    return () => clearInterval(timer);
  }, [visible, permission?.granted, autoScan, selectedDoorId, durationSec]);

  const toneStyle =
    banner.tone === 'success'
      ? { bg: 'rgba(16,185,129,0.16)', border: '#10b981', text: '#6ee7b7' }
      : banner.tone === 'danger'
        ? { bg: 'rgba(239,68,68,0.16)', border: '#ef4444', text: '#fca5a5' }
        : banner.tone === 'warn'
          ? { bg: 'rgba(245,158,11,0.16)', border: '#f59e0b', text: '#fcd34d' }
          : { bg: 'rgba(56,189,248,0.14)', border: '#38bdf8', text: '#bae6fd' };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Live Face Unlock</Text>
            <Text style={styles.sub}>{hudText}</Text>
          </View>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color="#f8fafc" />
          </Pressable>
        </View>

        <View style={styles.controlsRow}>
          <View style={styles.doorPillsWrap}>
            {doors.slice(0, 4).map((d) => {
              const active = d.id === selectedDoorId;
              return (
                <Pressable
                  key={d.id}
                  onPress={() => setSelectedDoorId(d.id)}
                  style={[styles.doorPill, active && styles.doorPillActive]}
                >
                  <Text
                    style={[
                      styles.doorPillText,
                      active && { color: '#052e16', fontWeight: '700' },
                    ]}
                    numberOfLines={1}
                  >
                    {d.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.durBox}>
            <Text style={styles.durLabel}>Durasi(s)</Text>
            <TextInput
              style={styles.durInput}
              value={durationSec}
              onChangeText={setDurationSec}
              keyboardType="number-pad"
              maxLength={2}
            />
          </View>
        </View>

        <View
          style={styles.cameraWrap}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setPreviewSize({ w: width, h: height });
          }}
        >
          {!permission?.granted ? (
            <View style={styles.permBox}>
              <Ionicons name="camera-outline" size={40} color="#64748b" />
              <Text style={styles.permText}>
                Izin kamera diperlukan untuk Live Face Unlock.
              </Text>
              <Pressable onPress={requestPermission} style={styles.permBtn}>
                <Text style={styles.permBtnText}>Izinkan Kamera</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <CameraView
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                facing={facing}
                animateShutter={false}
              />

              {/* Bounding box overlay */}
              {boxes.map((f, idx) => {
                if (!f.box) return null;
                const scaleX = previewSize.w / (imgSize.w || 480);
                const scaleY = previewSize.h / (imgSize.h || 640);
                const boxW = f.box.width * scaleX;
                const boxH = f.box.height * scaleY;
                const rawLeft = f.box.x * scaleX;
                const left =
                  facing === 'front' ? previewSize.w - rawLeft - boxW : rawLeft;
                const top = f.box.y * scaleY;
                const color = f.matched
                  ? f.permitted
                    ? '#10b981'
                    : '#ef4444'
                  : '#f59e0b';

                return (
                  <View
                    key={idx}
                    pointerEvents="none"
                    style={[
                      styles.faceBox,
                      {
                        left: Math.max(0, left),
                        top: Math.max(0, top),
                        width: Math.max(40, boxW),
                        height: Math.max(40, boxH),
                        borderColor: color,
                      },
                    ]}
                  >
                    <View style={[styles.faceTag, { backgroundColor: color }]}>
                      <Text style={styles.faceTagText}>
                        {f.matched
                          ? `${f.name} (${f.confidence}%)`
                          : `Unknown (${f.confidence}%)`}
                      </Text>
                    </View>
                  </View>
                );
              })}

              <Pressable
                onPress={() => setFacing(facing === 'front' ? 'back' : 'front')}
                style={styles.flipBtn}
              >
                <Ionicons name="camera-reverse-outline" size={22} color="#f8fafc" />
              </Pressable>
            </>
          )}
        </View>

        <View
          style={[
            styles.banner,
            { backgroundColor: toneStyle.bg, borderColor: toneStyle.border },
          ]}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.bannerTitle, { color: toneStyle.text }]}>
              {banner.title}
            </Text>
            {banner.sub ? (
              <Text style={styles.bannerSub}>{banner.sub}</Text>
            ) : null}
          </View>
          {pausedAfterMatch ? (
            <Pressable
              onPress={() => {
                pausedRef.current = false;
                setPausedAfterMatch(false);
                setBoxes([]);
              }}
              style={styles.resumeBtn}
            >
              <Ionicons name="refresh" size={16} color="#f8fafc" />
              <Text style={styles.resumeText}>Scan Lagi</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.footer}>
          <Pressable
            onPress={() => setAutoScan(!autoScan)}
            style={[
              styles.autoBtn,
              autoScan && { borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.14)' },
            ]}
          >
            <Ionicons
              name={autoScan ? 'radio-button-on' : 'radio-button-off'}
              size={18}
              color={autoScan ? '#34d399' : '#94a3b8'}
            />
            <Text style={{ color: '#f8fafc', fontSize: 13, fontWeight: '600' }}>
              Auto-Scan: {autoScan ? 'ON' : 'OFF'}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => scanOneFrame(true)}
            disabled={scanning}
            style={styles.manualBtn}
          >
            {scanning ? (
              <ActivityIndicator color="#052e16" size="small" />
            ) : (
              <>
                <Ionicons name="scan" size={18} color="#052e16" />
                <Text style={styles.manualText}>Scan Sekarang</Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#090d16', paddingTop: 44, paddingBottom: 20 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  title: { fontSize: 18, fontWeight: '700', color: '#f8fafc' },
  sub: { fontSize: 11.5, color: '#94a3b8', marginTop: 2 },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  doorPillsWrap: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  doorPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#334155',
    maxWidth: 130,
  },
  doorPillActive: { backgroundColor: '#10b981', borderColor: '#10b981' },
  doorPillText: { fontSize: 11.5, color: '#cbd5e1' },
  durBox: { alignItems: 'center', gap: 2 },
  durLabel: { fontSize: 10, color: '#94a3b8' },
  durInput: {
    width: 48,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    color: '#f8fafc',
    textAlign: 'center',
    paddingVertical: 4,
    fontSize: 13,
    fontWeight: '700',
  },
  cameraWrap: {
    flex: 1,
    marginHorizontal: 16,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  permBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  permText: { color: '#cbd5e1', textAlign: 'center', fontSize: 13.5 },
  permBtn: {
    backgroundColor: '#10b981',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  permBtnText: { color: '#052e16', fontWeight: '700' },
  faceBox: {
    position: 'absolute',
    borderWidth: 2.5,
    borderRadius: 10,
  },
  faceTag: {
    position: 'absolute',
    top: -22,
    left: 0,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  faceTagText: { color: '#090d16', fontSize: 10.5, fontWeight: '700' },
  flipBtn: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  bannerTitle: { fontSize: 13.5, fontWeight: '700' },
  bannerSub: { fontSize: 11.5, color: '#cbd5e1', marginTop: 2 },
  resumeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  resumeText: { color: '#f8fafc', fontSize: 12, fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    marginTop: 10,
  },
  autoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#111827',
    paddingVertical: 12,
  },
  manualBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    backgroundColor: '#10b981',
    paddingVertical: 12,
  },
  manualText: { color: '#052e16', fontWeight: '700', fontSize: 13.5 },
});
