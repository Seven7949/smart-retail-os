import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';
import { buildTimeConfig, validateConfig } from '../api/config';
import { useAppState, useStoreInstance, useT } from '../data/hooks';
import { Button, Card, Chip, Field, Screen, Tap, styles } from '../ui/components';
import { colors, space, type } from '../ui/theme';
import { useToast } from '../ui/toast';

export default function SettingsScreen() {
  const store = useStoreInstance();
  const t = useT();
  const toast = useToast();
  const s = useAppState((x) => x.settings);
  const syncing = useAppState((x) => x.syncing);
  const [shopName, setShopName] = useState(s.shopName);
  const [upiId, setUpiId] = useState(s.upiId);
  const [cfg, setCfg] = useState({ apiUrl: s.cloud.apiUrl ?? '', region: s.cloud.region ?? 'ap-south-1', userPoolId: s.cloud.userPoolId ?? '', clientId: s.cloud.clientId ?? '' });
  const [showCfg, setShowCfg] = useState(!validateConfig(s.cloud).ok);
  const [email, setEmail] = useState(s.email ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'signin' | 'signup' | 'confirm'>('signin');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = () => run(async () => {
    if (upiId && !/^[\w.-]{2,64}@[A-Za-z]{2,32}$/.test(upiId.trim())) throw new Error('UPI ID looks like name@bank');
    await store.updateSettings({ shopName: shopName.trim(), upiId: upiId.trim() });
  }, t('save') + ' ✓');

  const applyCfg = () => run(async () => {
    const v = validateConfig(cfg);
    if (!v.ok) throw new Error(v.error);
    await store.updateSettings({ cloud: v.config });
    setShowCfg(false);
  }, 'Cloud configured ✓');

  // Your login token and shop data go to this address: warn before pointing the app somewhere new.
  const saveCfg = () => {
    const builtIn = buildTimeConfig().apiUrl;
    const host = (u?: string) => { try { return u ? new URL(u).host : ''; } catch { return ''; } };
    if (builtIn && host(builtIn) !== host(cfg.apiUrl)) {
      Alert.alert('Change cloud server?', `Your sign-in and shop data will be sent to ${host(cfg.apiUrl) || cfg.apiUrl}. Only do this if you deployed that server yourself.`, [
        { text: t('cancel'), style: 'cancel' }, { text: 'Use it', style: 'destructive', onPress: applyCfg },
      ]);
    } else applyCfg();
  };

  return (
    <Screen title={t('settings')} right={<Tap onPress={() => router.back()} accessibilityLabel="close"><Ionicons name="close" size={28} color={colors.ink} /></Tap>}>
      <Card>
        <Text style={[type.label, { marginBottom: space.sm }]}>{t('language')}</Text>
        <View style={{ flexDirection: 'row' }}>
          <Chip label="English" selected={s.lang === 'en'} onPress={() => store.updateSettings({ lang: 'en' })} />
          <Chip label="हिंदी" selected={s.lang === 'hi'} onPress={() => store.updateSettings({ lang: 'hi' })} />
        </View>
      </Card>
      <Card>
        <Field label={t('shopName')} value={shopName} onChangeText={setShopName} maxLength={80} />
        <Field label={t('upiId')} value={upiId} onChangeText={setUpiId} autoCapitalize="none" placeholder="shopname@upi" />
        <Button title={t('save')} variant="secondary" onPress={saveProfile} />
      </Card>

      <Text style={[type.heading, { marginTop: space.md, marginBottom: space.sm }]}>{t('cloud')}</Text>
      <Card>
        {showCfg ? (
          <>
            <Text style={[type.small, { marginBottom: space.md }]}>Paste the outputs printed by the "Deploy AWS" GitHub workflow (they are public IDs, not secrets).</Text>
            <Field label={t('apiUrl')} value={cfg.apiUrl} onChangeText={(v) => setCfg({ ...cfg, apiUrl: v })} autoCapitalize="none" placeholder="https://xxxx.execute-api.ap-south-1.amazonaws.com" />
            <Field label={t('region')} value={cfg.region} onChangeText={(v) => setCfg({ ...cfg, region: v })} autoCapitalize="none" />
            <Field label={t('userPool')} value={cfg.userPoolId} onChangeText={(v) => setCfg({ ...cfg, userPoolId: v })} autoCapitalize="none" />
            <Field label={t('clientId')} value={cfg.clientId} onChangeText={(v) => setCfg({ ...cfg, clientId: v })} autoCapitalize="none" />
            <Button title={t('save')} onPress={saveCfg} loading={busy} />
          </>
        ) : s.email ? (
          <>
            <View style={styles.row}>
              <Ionicons name="cloud-done" size={22} color={colors.success} />
              <Text style={[type.bodyStrong, { marginLeft: 8, flex: 1 }]}>{s.email}</Text>
            </View>
            <Text style={[type.small, { marginTop: 4 }]}>{t('lastSync')}: {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString('en-IN') : t('never')}</Text>
            <View style={[styles.row, { justifyContent: 'space-between', marginVertical: space.md }]}>
              <Text style={type.body}>{t('dailyDigest')}</Text>
              <Switch value={s.digestOptIn} onValueChange={(v) => store.updateSettings({ digestOptIn: v })} trackColor={{ true: colors.primary, false: colors.line }} />
            </View>
            <Button title={t('syncNow')} icon="sync" loading={syncing || busy}
              onPress={() => run(async () => { const r = await store.sync(); toast(`Synced · ${r.signed} bills signed`); })} />
            <Button title="Refresh cloud insights now" icon="sparkles-outline" variant="ghost" style={{ marginTop: space.sm }}
              onPress={() => run(() => store.api().refreshInsights(), 'Queued. Results arrive in a minute.')} />
            <Button title={t('signOut')} variant="ghost" onPress={() => run(() => store.signOut())} />
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', marginBottom: space.md }}>
              <Chip label={t('signIn')} selected={stage === 'signin'} onPress={() => setStage('signin')} />
              <Chip label={t('signUp')} selected={stage !== 'signin'} onPress={() => setStage('signup')} />
            </View>
            <Field label={t('email')} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
            {stage !== 'confirm' && <Field label={t('password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />}
            {stage === 'confirm' && <Field label={t('verifyCode')} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={8} />}
            {stage === 'signin' && <Button title={t('signIn')} loading={busy} onPress={() => run(async () => { await store.signIn(email, password); setPassword(''); }, 'Signed in ✓')} />}
            {stage === 'signup' && <Button title={t('signUp')} loading={busy} onPress={() => run(async () => { await store.signUp(email, password); setStage('confirm'); }, 'Code sent to your email')} />}
            {stage === 'confirm' && <Button title={t('confirm')} loading={busy} onPress={() => run(async () => { await store.confirmSignUp(email, code); await store.signIn(email, password); setPassword(''); }, 'Account ready ✓')} />}
            <Button title="Edit cloud details" variant="ghost" onPress={() => setShowCfg(true)} style={{ marginTop: space.sm }} />
          </>
        )}
      </Card>

      <Button title={t('verifyLedger')} icon="shield-checkmark-outline" variant="secondary" onPress={() => router.push('/ledger')} style={{ marginTop: space.md }} />
      <Button title={t('resetData')} icon="trash-outline" variant="danger" style={{ marginTop: space.md }}
        onPress={() => Alert.alert(t('resetData'), 'This deletes every bill, item and khata entry on this phone.', [
          { text: t('cancel'), style: 'cancel' },
          { text: t('resetData'), style: 'destructive', onPress: () => run(async () => { await store.resetAll(); router.replace('/welcome'); }) },
        ])} />
      <Text style={[type.small, { textAlign: 'center', marginTop: space.lg }]}>Dukaan AI · Smart Retail OS v1.0 · shop {s.shopId.slice(0, 8)}</Text>
    </Screen>
  );
}
