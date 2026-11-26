import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useAppState, useInsights, useStoreInstance, useT } from '../../data/hooks';
import { formatQty, parseRupees } from '../../domain/money';
import type { Item, Unit } from '../../domain/types';
import { ForecastChart } from '../../ui/charts';
import { Button, Card, Field, Screen, Segmented } from '../../ui/components';
import { colors, space, type } from '../../ui/theme';
import { useToast } from '../../ui/toast';

const toRupees = (p: number) => (p / 100).toString();

export default function ItemEdit() {
  const { sku } = useLocalSearchParams<{ sku: string }>();
  const store = useStoreInstance();
  const t = useT();
  const toast = useToast();
  const insights = useInsights();
  const existing = useAppState((s) => s.items.find((i) => i.sku === sku));
  const isNew = !existing;
  const [name, setName] = useState(existing?.name ?? '');
  const [unit, setUnit] = useState<Unit>(existing?.unit ?? 'pcs');
  const [price, setPrice] = useState(existing ? toRupees(existing.pricePaise) : '');
  const [cost, setCost] = useState(existing ? toRupees(existing.costPaise) : '');
  const [stock, setStock] = useState(existing ? String(existing.stockMilli / 1000) : '0');
  const [pack, setPack] = useState(String(existing?.packSize ?? 1));
  const [lead, setLead] = useState(String(existing?.leadTimeDays ?? 2));
  const [busy, setBusy] = useState(false);
  const fc = existing ? insights?.forecasts[existing.sku] : undefined;

  const save = async () => {
    const pricePaise = parseRupees(price);
    const costPaise = parseRupees(cost || price);
    const stockNum = Number(stock);
    if (!name.trim() || !pricePaise || !costPaise || !Number.isFinite(stockNum)) { toast('Please check name, prices and stock', 'danger'); return; }
    const base: Item = existing ?? {
      sku: `custom-${Date.now().toString(36)}`, name: '', category: 'staples', unit, pricePaise, costPaise, stockMilli: 0,
      leadTimeDays: 2, packSize: 1, shelfLifeDays: 180, festivalLift: 1,
    };
    setBusy(true);
    try {
      await store.upsertItem({
        ...base, name: name.trim(), unit, pricePaise, costPaise, stockMilli: Math.round(stockNum * 1000),
        packSize: Math.max(1, Math.round(Number(pack) || 1)), leadTimeDays: Math.max(0, Math.round(Number(lead) || 0)),
      });
      toast(t('save') + ' ✓');
      router.back();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={isNew ? t('addItem') : t('editItem')}>
      {fc && existing ? (
        <Card>
          <Text style={type.heading}>{t('forecast')}</Text>
          <Text style={[type.small, { marginBottom: space.sm }]}>
            {t('next14')}: {formatQty(existing.unit === 'pcs' ? Math.round(fc.forecast.reduce((a, b) => a + b, 0)) * 1000 : Math.round(fc.forecast.reduce((a, b) => a + b, 0) * 10) * 100, existing.unit)}
            {fc.accuracy !== null ? ` · ${t('accuracy')} ${Math.round(fc.accuracy * 100)}%` : ''}
          </Text>
          <ForecastChart history={fc.history} forecast={fc.forecast} sigma={fc.sigma} />
        </Card>
      ) : null}
      <Field label={t('name')} value={name} onChangeText={setName} maxLength={80} />
      <View style={{ marginBottom: space.md }}>
        <Segmented<Unit> value={unit} onChange={setUnit} options={[{ value: 'pcs', label: 'pcs' }, { value: 'kg', label: 'kg' }, { value: 'l', label: 'litre' }]} />
      </View>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}><Field label={t('price')} value={price} onChangeText={setPrice} keyboardType="decimal-pad" /></View>
        <View style={{ flex: 1 }}><Field label={t('cost')} value={cost} onChangeText={setCost} keyboardType="decimal-pad" /></View>
      </View>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}><Field label={`${t('stockQty')} (${unit})`} value={stock} onChangeText={setStock} keyboardType="decimal-pad" /></View>
        <View style={{ flex: 1 }}><Field label={t('packSize')} value={pack} onChangeText={setPack} keyboardType="number-pad" /></View>
        <View style={{ flex: 1 }}><Field label={t('leadTime')} value={lead} onChangeText={setLead} keyboardType="number-pad" /></View>
      </View>
      <Button title={t('save')} icon="checkmark" onPress={save} loading={busy} />
      <Button title={t('cancel')} variant="ghost" onPress={() => router.back()} style={{ marginTop: space.sm }} />
      <Text style={[type.small, { color: colors.muted, textAlign: 'center', marginTop: space.md }]}>{existing?.sku}</Text>
    </Screen>
  );
}
