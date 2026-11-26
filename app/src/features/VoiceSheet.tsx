import { Ionicons } from '@expo/vector-icons';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Text, TextInput, View } from 'react-native';
import { useAppState, useStoreInstance, useT } from '../data/hooks';
import { formatQty } from '../domain/money';
import type { Item } from '../domain/types';
import { needsCloudHelp, parseUtterance, type ParsedLine } from '../domain/voice';
import { Badge, Button, Chip, Sheet, Tap, styles } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import { useToast } from '../ui/toast';

export interface VoiceLine { item: Item; qtyMilli: number }

function Pulse({ active }: { active: boolean }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) { v.stopAnimation(); v.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1300, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [active, v]);
  return (
    <Animated.View pointerEvents="none" style={{
      position: 'absolute', width: 96, height: 96, borderRadius: 48, backgroundColor: colors.accent,
      opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
      transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
    }} />
  );
}

export function VoiceSheet({ visible, onClose, onAdd }: { visible: boolean; onClose: () => void; onAdd: (lines: VoiceLine[]) => void }) {
  const store = useStoreInstance();
  const t = useT();
  const toast = useToast();
  const items = useAppState((s) => s.items);
  const uiLang = useAppState((s) => s.settings.lang);
  const signedIn = useAppState((s) => !!s.settings.email);
  const [speechLang, setSpeechLang] = useState<'hi-IN' | 'en-IN'>(uiLang === 'hi' ? 'hi-IN' : 'en-IN');
  const [listening, setListening] = useState(false);
  const [text, setText] = useState('');
  const [cloudLines, setCloudLines] = useState<ParsedLine[] | null>(null);
  const [asking, setAsking] = useState(false);

  useSpeechRecognitionEvent('result', (e) => {
    setText(e.results[0]?.transcript ?? '');
    setCloudLines(null);
  });
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('error', (e) => {
    setListening(false);
    if (e.error !== 'no-speech' && e.error !== 'aborted') toast(`Mic: ${e.message}`, 'danger');
  });

  const parsed = useMemo(() => parseUtterance(text, items), [text, items]);
  const lines = cloudLines ?? parsed.lines;

  const start = async () => {
    if (listening) { ExpoSpeechRecognitionModule.stop(); return; }
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) { toast('Microphone permission is needed for voice billing', 'accent'); return; }
      setText('');
      setCloudLines(null);
      setListening(true);
      ExpoSpeechRecognitionModule.start({ lang: speechLang, interimResults: true, continuous: false, maxAlternatives: 1 });
    } catch {
      setListening(false);
      toast('Speech recognition is not available on this phone. Type instead.', 'accent');
    }
  };

  const askCloud = async () => {
    setAsking(true);
    try {
      const res = await store.api().voiceParse(text, items);
      const bySku = new Map(items.map((i) => [i.sku, i]));
      setCloudLines(res.lines.filter((l) => bySku.has(l.sku)).map((l) => ({ item: bySku.get(l.sku)!, qtyMilli: l.qtyMilli, confidence: 0.9, heard: 'AI' })));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'AI is unavailable', 'danger');
    } finally {
      setAsking(false);
    }
  };

  const close = () => {
    if (listening) ExpoSpeechRecognitionModule.stop();
    setText('');
    setCloudLines(null);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={close} title={t('voiceBill')}>
      <View style={{ flexDirection: 'row', marginBottom: space.md }}>
        <Chip label="हिंदी / Hinglish" selected={speechLang === 'hi-IN'} onPress={() => setSpeechLang('hi-IN')} />
        <Chip label="English" selected={speechLang === 'en-IN'} onPress={() => setSpeechLang('en-IN')} />
      </View>
      <View style={{ alignItems: 'center', marginVertical: space.md }}>
        <View style={{ alignItems: 'center', justifyContent: 'center', width: 120, height: 120 }}>
          <Pulse active={listening} />
          <Tap onPress={start} haptic accessibilityLabel="microphone" style={{
            width: 96, height: 96, borderRadius: 48, backgroundColor: listening ? colors.accent : colors.primary, alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons name={listening ? 'stop' : 'mic'} size={42} color="#fff" />
          </Tap>
        </View>
        <Text style={[type.bodyStrong, { marginTop: space.sm }]}>{listening ? t('listening') : t('tapToSpeak')}</Text>
        <Text style={type.small}>{t('voiceExample')}</Text>
      </View>
      <TextInput
        value={text}
        onChangeText={(v) => { setText(v); setCloudLines(null); }}
        placeholder={t('typeInstead')}
        placeholderTextColor={colors.muted}
        multiline
        maxLength={300}
        accessibilityLabel={t('typeInstead')}
        style={{ minHeight: 56, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, padding: space.md, fontSize: 16, color: colors.ink }}
      />
      {lines.map((l) => (
        <View key={l.item.sku} style={[styles.row, { paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line }]}>
          <View style={{ flex: 1 }}>
            <Text style={type.bodyStrong}>{l.item.name}</Text>
            <Text style={type.small}>{t('heard')}: “{l.heard}”</Text>
          </View>
          <Text style={[type.bodyStrong, { marginRight: space.sm }]}>{formatQty(l.qtyMilli, l.item.unit)}</Text>
          <Badge label={`${Math.round(l.confidence * 100)}%`} tone={l.confidence >= 0.85 ? 'success' : l.confidence >= 0.7 ? 'accent' : 'danger'} />
        </View>
      ))}
      {!cloudLines && parsed.unmatched.length > 0 && (
        <Text style={[type.small, { color: colors.danger, marginTop: space.sm }]}>{t('didntCatch', { w: parsed.unmatched.join(', ') })}</Text>
      )}
      {text.trim().length > 0 && !cloudLines && needsCloudHelp(parsed) && signedIn && (
        <Button title={t('askCloud')} icon="sparkles-outline" variant="secondary" onPress={askCloud} loading={asking} style={{ marginTop: space.md }} />
      )}
      <Button
        title={t('addToBill')} icon="add-circle-outline" style={{ marginTop: space.md }} disabled={!lines.length}
        onPress={() => { onAdd(lines.map((l) => ({ item: l.item, qtyMilli: l.qtyMilli }))); close(); }}
      />
    </Sheet>
  );
}
