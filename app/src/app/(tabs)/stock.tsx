import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppState, useInsights, useT } from '../../data/hooks';
import { formatQty, formatRupees } from '../../domain/money';
import { Badge, Chip, ProgressBar, Tap, styles } from '../../ui/components';
import { colors, radius, shadow, space, type } from '../../ui/theme';

type Filter = 'all' | 'low' | 'reorder';

export default function StockScreen() {
  const t = useT();
  const params = useLocalSearchParams<{ filter?: Filter }>();
  const items = useAppState((s) => s.items);
  const insights = useInsights();
  const [filter, setFilter] = useState<Filter>(params.filter ?? 'all');
  const [query, setQuery] = useState('');

  const reorder = useMemo(() => new Map((insights?.reorder ?? []).map((r) => [r.sku, r])), [insights]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .map((it) => {
        const fc = insights?.forecasts[it.sku];
        const daily = fc ? fc.forecast.slice(0, 7).reduce((a, b) => a + b, 0) / 7 : 0;
        const cover = daily > 0 ? it.stockMilli / 1000 / daily : Infinity;
        return { it, cover, reorder: reorder.get(it.sku) };
      })
      .filter(({ it, cover, reorder: r }) =>
        (!q || it.name.toLowerCase().includes(q)) &&
        (filter === 'all' || (filter === 'low' && cover < 3) || (filter === 'reorder' && !!r)))
      .sort((a, b) => a.cover - b.cover);
  }, [items, insights, reorder, filter, query]);
  const value = useMemo(() => items.reduce((s, i) => s + Math.max(0, i.stockMilli) * i.costPaise / 1000, 0), [items]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
        <View style={[styles.row, { justifyContent: 'space-between', marginBottom: space.sm }]}>
          <View>
            <Text style={type.display}>{t('stock')}</Text>
            <Text style={type.small}>{items.length} items · {formatRupees(Math.round(value), { compact: true })}</Text>
          </View>
          <Tap onPress={() => router.push({ pathname: '/item/[sku]', params: { sku: 'new' } })} haptic accessibilityLabel={t('addItem')}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="add" size={24} color={colors.primary} />
          </Tap>
        </View>
        <View style={[styles.row, { backgroundColor: colors.card, borderRadius: radius.md, paddingHorizontal: space.md, height: 46, borderWidth: 1, borderColor: colors.line }]}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput value={query} onChangeText={setQuery} placeholder={t('searchItems')} placeholderTextColor={colors.muted}
            style={{ flex: 1, marginLeft: 8, fontSize: 16, color: colors.ink }} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: space.md }}>
          <Chip label={t('all')} selected={filter === 'all'} onPress={() => setFilter('all')} />
          <Chip label={t('lowStock')} icon="alert-circle-outline" selected={filter === 'low'} onPress={() => setFilter('low')} />
          <Chip label={`${t('reorder')} (${reorder.size})`} icon="cart-outline" selected={filter === 'reorder'} onPress={() => setFilter('reorder')} />
        </ScrollView>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.it.sku}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: 140 }}
        renderItem={({ item: { it, cover, reorder: r } }) => {
          const tone = cover < 2 ? 'danger' : cover < 5 ? 'accent' : 'success';
          return (
            <Tap onPress={() => router.push({ pathname: '/item/[sku]', params: { sku: it.sku } })}
              style={{ backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, marginBottom: space.sm, ...shadow }}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={type.bodyStrong} numberOfLines={1}>{it.name}</Text>
                  <Text style={type.small}>{formatQty(Math.max(0, it.stockMilli), it.unit)} {t('inStock')} · {formatRupees(it.pricePaise)}</Text>
                </View>
                {r ? <Badge label={`+${r.orderUnits}`} tone={r.reason === 'festival' ? 'accent' : 'primary'} icon="cart-outline" /> : null}
              </View>
              <View style={{ marginTop: space.sm }}>
                <ProgressBar value={Number.isFinite(cover) ? cover / 14 : 1} tone={tone} />
                <Text style={[type.small, { marginTop: 4 }]}>{Number.isFinite(cover) ? t('daysCover', { n: Math.max(0, Math.round(cover * 10) / 10) }) : '—'}</Text>
              </View>
            </Tap>
          );
        }}
      />
      <Tap onPress={() => router.push('/scan')} haptic accessibilityLabel={t('scanInvoice')} style={{
        position: 'absolute', right: space.lg, bottom: space.lg, backgroundColor: colors.primary, borderRadius: radius.pill,
        height: 56, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', ...shadow,
      }}>
        <Ionicons name="scan" size={22} color="#fff" />
        <Text style={[type.bodyStrong, { color: '#fff', marginLeft: 8 }]}>{t('scanInvoice')}</Text>
      </Tap>
    </SafeAreaView>
  );
}
