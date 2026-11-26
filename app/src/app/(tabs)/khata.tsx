import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppState, useInsights, useStoreInstance, useT } from '../../data/hooks';
import { formatRupees, parseRupees } from '../../domain/money';
import { Badge, Button, EmptyState, Field, Sheet, Tap, styles } from '../../ui/components';
import { colors, radius, shadow, space, type } from '../../ui/theme';
import { useToast } from '../../ui/toast';

const BAND_TONE = { low: 'success', medium: 'accent', high: 'danger' } as const;

export default function Khata() {
  const store = useStoreInstance();
  const t = useT();
  const toast = useToast();
  const customers = useAppState((s) => s.customers);
  const udhaar = useAppState((s) => s.udhaar);
  const insights = useInsights();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [limit, setLimit] = useState('');

  const balances = useMemo(() => {
    const m = new Map<string, number>();
    udhaar.forEach((u) => m.set(u.customerId, (m.get(u.customerId) ?? 0) + (u.kind === 'credit' ? u.amountPaise : -u.amountPaise)));
    return m;
  }, [udhaar]);
  const risk = useMemo(() => new Map((insights?.udhaar ?? []).map((r) => [r.customerId, r])), [insights]);
  const rows = useMemo(() => [...customers].sort((a, b) =>
    (risk.get(b.customerId)?.risk ?? -1) - (risk.get(a.customerId)?.risk ?? -1) || (balances.get(b.customerId) ?? 0) - (balances.get(a.customerId) ?? 0)),
  [customers, risk, balances]);
  const total = [...balances.values()].reduce((s, v) => s + Math.max(0, v), 0);

  const add = async () => {
    try {
      const c = await store.addCustomer(name, phone || undefined, limit ? parseRupees(limit) ?? undefined : undefined);
      setAdding(false);
      setName(''); setPhone(''); setLimit('');
      router.push({ pathname: '/customer/[id]', params: { id: c.customerId } });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add', 'danger');
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <FlatList
        data={rows}
        keyExtractor={(c) => c.customerId}
        contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}
        ListHeaderComponent={
          <>
            <View style={[styles.row, { justifyContent: 'space-between', marginBottom: space.lg }]}>
              <Text style={type.display}>{t('khata')}</Text>
              <Tap onPress={() => setAdding(true)} haptic accessibilityLabel={t('addCustomer')}
                style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="person-add" size={20} color={colors.primary} />
              </Tap>
            </View>
            <View style={{ backgroundColor: colors.ink, borderRadius: radius.lg, padding: space.lg, marginBottom: space.lg }}>
              <Text style={[type.label, { color: '#9CA3AF' }]}>{t('outstanding')}</Text>
              <Text style={[type.display, type.number, { color: '#fff', marginTop: 4 }]}>{formatRupees(total)}</Text>
              <Text style={[type.small, { color: '#9CA3AF', marginTop: 4 }]}>
                {(insights?.udhaar ?? []).filter((r) => r.band === 'high').length} {t('high')} {t('risk').toLowerCase()} · {customers.length} {t('customers').toLowerCase()}
              </Text>
            </View>
          </>
        }
        ListEmptyComponent={<EmptyState icon="book-outline" text={t('noCustomers')} />}
        renderItem={({ item: c }) => {
          const bal = balances.get(c.customerId) ?? 0;
          const r = risk.get(c.customerId);
          return (
            <Tap onPress={() => router.push({ pathname: '/customer/[id]', params: { id: c.customerId } })}
              style={{ backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, marginBottom: space.sm, flexDirection: 'row', alignItems: 'center', ...shadow }}>
              <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: colors.primary, fontWeight: '800', fontSize: 16 }}>{c.name.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1, marginLeft: space.md }}>
                <Text style={type.bodyStrong} numberOfLines={1}>{c.name}</Text>
                {r ? <Badge label={`${t('risk')}: ${t(r.band)}`} tone={BAND_TONE[r.band]} /> : <Text style={type.small}>{bal > 0 ? '' : t('settled')}</Text>}
              </View>
              <Text style={[type.heading, type.number, { color: bal > 0 ? colors.danger : colors.success }]}>{formatRupees(Math.max(0, bal))}</Text>
            </Tap>
          );
        }}
      />
      <Sheet visible={adding} onClose={() => setAdding(false)} title={t('addCustomer')}>
        <Field label={t('name')} value={name} onChangeText={setName} maxLength={80} autoFocus />
        <Field label={t('phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={15} />
        <Field label={t('creditLimit')} value={limit} onChangeText={setLimit} keyboardType="decimal-pad" />
        <Button title={t('save')} icon="checkmark" onPress={add} disabled={!name.trim()} />
      </Sheet>
    </SafeAreaView>
  );
}
