import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppState, useInsights, useLedgerStatus, useT } from '../../data/hooks';
import { formatRupees } from '../../domain/money';
import { dayKey } from '../../ml/calendar';
import { Sparkline } from '../../ui/charts';
import { Badge, Card, IconCircle, SectionHeader, Stat, Tap, styles, type IconName } from '../../ui/components';
import { colors, radius, space, type } from '../../ui/theme';

function greeting(t: ReturnType<typeof useT>) {
  const h = new Date().getHours();
  return t(h < 12 ? 'goodMorning' : h < 17 ? 'goodAfternoon' : 'goodEvening');
}

export default function Home() {
  const t = useT();
  const shopName = useAppState((s) => s.settings.shopName);
  const chain = useAppState((s) => s.chain);
  const items = useAppState((s) => s.items);
  const insights = useInsights();

  const today = useMemo(() => {
    const key = dayKey(Date.now());
    const bills = chain.filter((r) => dayKey(r.bill.createdAt) === key);
    const paise = bills.reduce((s, r) => s + r.bill.totalPaise, 0);
    return { count: bills.length, paise, avg: bills.length ? Math.round(paise / bills.length) : 0 };
  }, [chain]);
  const ledger = useLedgerStatus();
  const signed = useMemo(() => chain.filter((r) => r.signature).length, [chain]);
  const names = useMemo(() => new Map(items.map((i) => [i.sku, i.name])), [items]);

  const actions: { icon: IconName; label: string; onPress: () => void; tone: 'primary' | 'accent' | 'info' | 'success' }[] = [
    { icon: 'receipt-outline', label: t('newBill'), onPress: () => router.push('/bill'), tone: 'primary' },
    { icon: 'mic-outline', label: t('voiceBill'), onPress: () => router.push({ pathname: '/bill', params: { voice: String(Date.now()) } }), tone: 'accent' },
    { icon: 'scan-outline', label: t('scanInvoice'), onPress: () => router.push('/scan'), tone: 'info' },
    { icon: 'book-outline', label: t('addUdhaar'), onPress: () => router.push('/khata'), tone: 'success' },
  ];

  const spark = insights ? [...insights.salesByDay.slice(-21).map((d) => d.paise), ...insights.forecastSalesPaise.slice(0, 7)] : [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 120 }}>
        <View style={[styles.row, { justifyContent: 'space-between', marginBottom: space.lg }]}>
          <View style={{ flex: 1 }}>
            <Text style={type.small}>{greeting(t)} 👋</Text>
            <Text style={type.title} numberOfLines={1}>{shopName || t('appName')}</Text>
          </View>
          <Tap onPress={() => router.push('/settings')} accessibilityLabel={t('settings')} style={{ padding: 6 }}>
            <Ionicons name="settings-outline" size={24} color={colors.ink} />
          </Tap>
        </View>

        <View style={{ backgroundColor: colors.primary, borderRadius: radius.lg, padding: space.lg, marginBottom: space.md }}>
          <Text style={[type.label, { color: '#CFE7E3' }]}>{t('today')}</Text>
          <Text style={[type.display, type.number, { color: '#fff', marginTop: 4 }]}>{formatRupees(today.paise)}</Text>
          <View style={[styles.row, { marginTop: space.md }]}>
            <Text style={[type.small, { color: '#CFE7E3' }]}>{today.count} {t('bills')} · {t('avgBill')} {formatRupees(today.avg)}</Text>
          </View>
          {spark.length > 7 && (
            <View style={{ marginTop: space.md }}>
              <Sparkline values={spark} dashedFrom={spark.length - 7} color="#fff" />
              <Text style={[type.small, { color: '#CFE7E3', marginTop: 4 }]}>{t('next7')}: {formatRupees(insights!.forecastSalesPaise.slice(0, 7).reduce((a, b) => a + b, 0), { compact: true })}</Text>
            </View>
          )}
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -space.xs }}>
          {actions.map((a) => (
            <View key={a.label} style={{ width: '50%', padding: space.xs }}>
              <Card onPress={a.onPress} style={{ marginBottom: 0, flexDirection: 'row', alignItems: 'center', padding: space.md }}>
                <IconCircle name={a.icon} tone={a.tone} />
                <Text style={[type.bodyStrong, { marginLeft: space.sm, flex: 1 }]} numberOfLines={2}>{a.label}</Text>
              </Card>
            </View>
          ))}
        </View>

        <Card onPress={() => router.push('/ledger')} style={{ marginTop: space.md, flexDirection: 'row', alignItems: 'center' }}>
          <IconCircle name={ledger && !ledger.valid ? 'warning' : 'shield-checkmark'} tone={ledger && !ledger.valid ? 'danger' : 'success'} />
          <View style={{ marginLeft: space.md, flex: 1 }}>
            <Text style={type.bodyStrong}>{ledger && !ledger.valid ? t('ledgerBroken') : t('ledgerVerified')}</Text>
            <Text style={type.small}>{t('billsSecured', { n: chain.length.toLocaleString('en-IN') })}{signed ? ` · ${t('signedCloud', { n: signed })}` : ''}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.muted} />
        </Card>

        {insights?.festival && (
          <Card style={{ backgroundColor: colors.accentSoft }}>
            <View style={styles.row}>
              <Text style={{ fontSize: 28, marginRight: space.md }}>🪔</Text>
              <View style={{ flex: 1 }}>
                <Text style={type.heading}>{insights.festival.name} {insights.festival.daysAway === 0 ? t('festivalToday') : t('festivalAhead', { n: insights.festival.daysAway })}</Text>
                <Text style={[type.small, { color: colors.inkSoft, marginTop: 2 }]}>
                  {t('stockUp')}: {insights.festival.stockUp.map((s) => names.get(s) ?? s).join(', ')}
                </Text>
              </View>
            </View>
          </Card>
        )}

        <SectionHeader title={t('reorderToday')} action={t('seeAll')} onAction={() => router.push({ pathname: '/stock', params: { filter: 'reorder' } })} />
        {!insights ? (
          <Card style={{ alignItems: 'center' }}><ActivityIndicator color={colors.primary} /><Text style={[type.small, { marginTop: 8 }]}>{t('computing')}</Text></Card>
        ) : insights.reorder.length === 0 ? (
          <Card><Text style={type.body}>{t('allGood')}</Text></Card>
        ) : (
          <Card style={{ paddingVertical: space.sm }}>
            {insights.reorder.slice(0, 4).map((r, i) => (
              <Tap key={r.sku} onPress={() => router.push({ pathname: '/item/[sku]', params: { sku: r.sku } })}>
                <View style={[styles.row, { paddingVertical: space.md, borderTopWidth: i ? 1 : 0, borderTopColor: colors.line }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={type.bodyStrong} numberOfLines={1}>{r.name}</Text>
                    <Text style={type.small}>{t('daysCover', { n: r.daysOfCover })}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[type.bodyStrong, { color: colors.primary }]}>+{r.orderUnits}</Text>
                    <Badge label={r.reason === 'festival' ? t('festivalDemand') : t('belowReorder')} tone={r.reason === 'festival' ? 'accent' : 'neutral'} />
                  </View>
                </View>
              </Tap>
            ))}
          </Card>
        )}

        {insights && insights.udhaar.length > 0 && (
          <Card onPress={() => router.push('/khata')} style={{ flexDirection: 'row' }}>
            <Stat label={t('outstanding')} value={formatRupees(insights.udhaar.reduce((s, u) => s + u.outstandingPaise, 0), { compact: true })} />
            <Stat label={`${t('risk')}: ${t('high')}`} value={String(insights.udhaar.filter((u) => u.band === 'high').length)} tone="danger" />
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
