import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useAppState, useStoreInstance, useT } from '../data/hooks';
import { Button, Card, Chip, Field, IconCircle, Screen } from '../ui/components';
import { colors, space, type } from '../ui/theme';
import { useToast } from '../ui/toast';

const FEATURES: { icon: keyof typeof Ionicons.glyphMap; en: string; hi: string }[] = [
  { icon: 'mic-outline', en: 'Bill by voice in Hindi or English', hi: 'हिंदी या अंग्रेज़ी में बोलकर बिल' },
  { icon: 'scan-outline', en: 'Snap supplier bills to update stock', hi: 'सप्लायर बिल की फ़ोटो से स्टॉक अपडेट' },
  { icon: 'trending-up-outline', en: 'Festival-aware demand forecasts', hi: 'त्योहार को समझने वाला अनुमान' },
  { icon: 'shield-checkmark-outline', en: 'Tamper-proof bills (Rust + Ed25519)', hi: 'छेड़छाड़-रहित बिल (Rust + Ed25519)' },
];

export default function Welcome() {
  const store = useStoreInstance();
  const lang = useAppState((s) => s.settings.lang);
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'demo' | 'fresh' | null>(null);

  const go = async (kind: 'demo' | 'fresh') => {
    setBusy(kind);
    try {
      if (kind === 'demo') await store.loadDemo();
      else await store.startFresh(name);
      router.replace('/');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong', 'danger');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: space.md }}>
        <Chip label="English" selected={lang === 'en'} onPress={() => store.updateSettings({ lang: 'en' })} />
        <Chip label="हिंदी" selected={lang === 'hi'} onPress={() => store.updateSettings({ lang: 'hi' })} />
      </View>
      <View style={{ alignItems: 'center', marginVertical: space.xl }}>
        <View style={{ width: 84, height: 84, borderRadius: 26, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="storefront" size={44} color="#fff" />
        </View>
        <Text style={[type.display, { marginTop: space.lg }]}>{t('appName')}</Text>
        <Text style={[type.body, { color: colors.muted, textAlign: 'center', marginTop: 6 }]}>{t('tagline')}</Text>
      </View>
      <Card>
        {FEATURES.map((f) => (
          <View key={f.icon} style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 8 }}>
            <IconCircle name={f.icon} size={36} />
            <Text style={[type.body, { marginLeft: space.md, flex: 1 }]}>{lang === 'hi' ? f.hi : f.en}</Text>
          </View>
        ))}
      </Card>
      <Button title={t('demoShop')} icon="sparkles" onPress={() => go('demo')} loading={busy === 'demo'} testID="demo" />
      <Text style={[type.small, { textAlign: 'center', marginVertical: space.sm }]}>{t('welcomeBody')}</Text>
      <View style={{ height: space.lg }} />
      <Field label={t('shopName')} value={name} onChangeText={setName} placeholder="Gupta Kirana Store" maxLength={80} />
      <Button title={t('startShop')} variant="secondary" icon="storefront-outline" onPress={() => go('fresh')} loading={busy === 'fresh'} />
    </Screen>
  );
}
