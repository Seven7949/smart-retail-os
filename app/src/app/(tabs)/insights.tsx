import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, Text, View } from 'react-native';
import { useAppState, useInsights, useT } from '../../data/hooks';
import { formatQty, formatRupees } from '../../domain/money';
import { addDays, festivalIntensity } from '../../ml/calendar';
import type { SegmentName } from '../../ml/insights';
import { Bars, ForecastChart } from '../../ui/charts';
import { Badge, Button, Card, Chip, Screen, Segmented, Stat, styles } from '../../ui/components';
import { colors, space, type } from '../../ui/theme';

type Tab = 'forecast' | 'reorder' | 'together' | 'customers';

const SEGMENT_TIPS: Record<SegmentName, { tone: string; en: string; hi: string; icon: keyof typeof Ionicons.glyphMap }> = {
  Champions: { tone: colors.primary, icon: 'trophy-outline', en: 'Highest spend: thank them, offer early festival packs.', hi: 'सबसे ज़्यादा खर्च: त्योहार पैक पहले दें।' },
  Regulars: { tone: colors.info, icon: 'repeat-outline', en: 'Visit often: keep their daily items always in stock.', hi: 'रोज़ आते हैं: उनका रोज़ का सामान हमेशा रखें।' },
  Occasional: { tone: colors.accent, icon: 'walk-outline', en: 'Come rarely: a small combo offer can bring them back.', hi: 'कभी-कभी आते हैं: छोटा कॉम्बो ऑफ़र दें।' },
  'At risk': { tone: colors.danger, icon: 'alert-circle-outline', en: 'Stopped coming: send a WhatsApp hello or discount.', hi: 'आना बंद: WhatsApp पर संपर्क करें।' },
  New: { tone: colors.muted, icon: 'person-add-outline', en: 'Not enough history yet.', hi: 'अभी पर्याप्त जानकारी नहीं।' },
};

export default function InsightsScreen() {
  const t = useT();
  const insights = useInsights();
  const items = useAppState((s) => s.items);
  const lang = useAppState((s) => s.settings.lang);
  const cloud = useAppState((s) => s.cloudInsights);
  const [tab, setTab] = useState<Tab>('forecast');
  const byS = useMemo(() => new Map(items.map((i) => [i.sku, i])), [items]);
  const top = useMemo(() => {
    if (!insights) return [];
    return [...items].sort((a, b) => {
      const ra = (insights.forecasts[a.sku]?.forecast.reduce((x, y) => x + y, 0) ?? 0) * a.pricePaise;
      const rb = (insights.forecasts[b.sku]?.forecast.reduce((x, y) => x + y, 0) ?? 0) * b.pricePaise;
      return rb - ra;
    }).slice(0, 12);
  }, [items, insights]);
  const [sku, setSku] = useState<string | null>(null);
  const selected = sku ?? top[0]?.sku ?? null;

  if (!insights) {
    return (
      <Screen title={t('insights')}>
        <Card style={{ alignItems: 'center', padding: space.xxl }}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={[type.body, { marginTop: space.md }]}>{t('computing')}</Text>
        </Card>
      </Screen>
    );
  }

  const fc = selected ? insights.forecasts[selected] : undefined;
  const item = selected ? byS.get(selected) : undefined;
  const festMarkers = fc ? fc.forecast.map((_, h) => (festivalIntensity(addDays(insights.todayKey, h + 1)) > 0.3 ? h : -1)).filter((h) => h >= 0) : [];
  const cloudMeta = cloud?.meta as { generatedAt?: number; forecastMethod?: string } | undefined;

  const orderText = () => [
    `Order from ${'Dukaan AI'}:`,
    ...insights.reorder.map((r) => `• ${r.name}: ${r.orderUnits} (${r.packs} packs)`),
  ].join('\n');

  return (
    <Screen title={t('insights')}>
      <View style={[styles.row, { marginBottom: space.md }]}>
        <Badge icon={cloudMeta ? 'cloud-done-outline' : 'phone-portrait-outline'} tone={cloudMeta ? 'info' : 'neutral'}
          label={cloudMeta ? `${t('cloudSource')} · ${cloudMeta.forecastMethod ?? ''}` : t('insightsSource')} />
      </View>
      <Segmented<Tab> value={tab} onChange={setTab} options={[
        { value: 'forecast', label: t('forecast') }, { value: 'reorder', label: t('reorder') },
        { value: 'together', label: t('together') }, { value: 'customers', label: t('customers') },
      ]} />
      <View style={{ height: space.md }} />

      {tab === 'forecast' && (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
            {top.map((i) => <Chip key={i.sku} label={i.name.split(' ').slice(0, 2).join(' ')} selected={selected === i.sku} onPress={() => setSku(i.sku)} />)}
          </ScrollView>
          {fc && item && (
            <Card>
              <Text style={type.heading}>{item.name}</Text>
              <Text style={[type.small, { marginBottom: space.md }]}>{t('last28')} → {t('next14')} · {fc.method}</Text>
              <ForecastChart history={fc.history} forecast={fc.forecast} sigma={fc.sigma} markers={festMarkers} />
              <View style={[styles.row, { marginTop: space.lg }]}>
                <Stat label={t('next14')} value={formatQty(item.unit === 'pcs' ? Math.round(fc.forecast.reduce((a, b) => a + b, 0)) * 1000 : Math.round(fc.forecast.reduce((a, b) => a + b, 0) * 10) * 100, item.unit)} />
                <Stat label={t('accuracy')} value={fc.accuracy !== null ? `${Math.round(fc.accuracy * 100)}%` : '—'}
                  sub={fc.baselineAccuracy !== null ? t('vsBaseline', { n: `${Math.round(fc.baselineAccuracy * 100)}%` }) : undefined} tone="success" />
              </View>
              {festMarkers.length > 0 && <Text style={[type.small, { color: colors.accent, marginTop: space.sm }]}>🪔 {t('festivalDemand')}</Text>}
            </Card>
          )}
          <Card>
            <Text style={type.heading}>{t('next7')}</Text>
            <View style={{ height: space.md }} />
            <Bars data={insights.forecastSalesPaise.slice(0, 7).map((p, h) => ({
              label: new Date(Date.parse(addDays(insights.todayKey, h + 1))).toLocaleDateString('en-IN', { weekday: 'short' }),
              value: p, tone: festivalIntensity(addDays(insights.todayKey, h + 1)) > 0.3 ? colors.accent : colors.primary,
            }))} />
            <Text style={[type.small, { marginTop: space.sm }]}>{formatRupees(insights.forecastSalesPaise.slice(0, 7).reduce((a, b) => a + b, 0))}</Text>
          </Card>
        </>
      )}

      {tab === 'reorder' && (
        <>
          {insights.reorder.length === 0 ? <Card><Text style={type.body}>{t('allGood')}</Text></Card> : (
            <Card style={{ paddingVertical: space.sm }}>
              {insights.reorder.map((r, i) => (
                <View key={r.sku} style={[styles.row, { paddingVertical: space.md, borderTopWidth: i ? 1 : 0, borderTopColor: colors.line }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={type.bodyStrong}>{r.name}</Text>
                    <Text style={type.small}>{t('daysCover', { n: r.daysOfCover })} · {t('orderPacks', { n: r.packs })}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[type.heading, { color: colors.primary }]}>+{r.orderUnits}</Text>
                    <Badge label={r.reason === 'festival' ? t('festivalDemand') : t('belowReorder')} tone={r.reason === 'festival' ? 'accent' : 'neutral'} />
                  </View>
                </View>
              ))}
            </Card>
          )}
          {insights.reorder.length > 0 && (
            <Button title={t('sendOrder')} icon="logo-whatsapp" variant="secondary"
              onPress={() => Linking.openURL(`https://wa.me/?text=${encodeURIComponent(orderText())}`).catch(() => undefined)} />
          )}
        </>
      )}

      {tab === 'together' && (
        <>
          {insights.rules.slice(0, 10).map((r, i) => (
            <Card key={i}>
              <Text style={type.body}>
                <Text style={type.bodyStrong}>{r.if.map((s) => byS.get(s)?.name ?? s).join(' + ')}</Text>
                {'  →  '}{t('alsoBuy')}{' '}
                <Text style={[type.bodyStrong, { color: colors.primary }]}>{r.then.map((s) => byS.get(s)?.name ?? s).join(' + ')}</Text>
              </Text>
              <View style={[styles.row, { marginTop: space.sm, gap: space.sm }]}>
                <Badge label={`${Math.round(r.confidence * 100)}%`} tone="primary" icon="checkmark-done-outline" />
                <Badge label={`${r.lift.toFixed(1)}× lift`} tone="accent" icon="trending-up-outline" />
                <Badge label={`${(r.support * 100).toFixed(1)}% bills`} tone="neutral" />
              </View>
            </Card>
          ))}
          <Text style={[type.small, { textAlign: 'center' }]}>{t('comboTip')}</Text>
        </>
      )}

      {tab === 'customers' && (
        <>
          <Card>
            <Text style={type.heading}>{t('segments')}</Text>
            <View style={{ height: space.md }} />
            <Bars data={(Object.keys(SEGMENT_TIPS) as SegmentName[]).filter((s) => insights.segmentCounts[s])
              .map((s) => ({ label: s, value: insights.segmentCounts[s] ?? 0, tone: SEGMENT_TIPS[s].tone }))} />
          </Card>
          {(Object.keys(SEGMENT_TIPS) as SegmentName[]).filter((s) => insights.segmentCounts[s]).map((s) => (
            <Card key={s} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name={SEGMENT_TIPS[s].icon} size={26} color={SEGMENT_TIPS[s].tone} />
              <View style={{ flex: 1, marginLeft: space.md }}>
                <Text style={type.bodyStrong}>{s} · {insights.segmentCounts[s]}</Text>
                <Text style={type.small}>{lang === 'hi' ? SEGMENT_TIPS[s].hi : SEGMENT_TIPS[s].en}</Text>
              </View>
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}
