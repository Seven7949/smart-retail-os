import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, Share, Text, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppState, useStoreInstance, useT } from '../../data/hooks';
import { addToCart, cartTotal, lineTotal, setQty, stepFor, type Cart } from '../../domain/billing';
import { CATEGORY_LABELS } from '../../domain/catalog';
import { formatQty, formatRupees } from '../../domain/money';
import type { ChainRecord, Item, PaymentMode } from '../../domain/types';
import { VoiceSheet } from '../../features/VoiceSheet';
import { Badge, Button, Chip, IconCircle, Segmented, Sheet, Stepper, Tap, styles } from '../../ui/components';
import { colors, radius, shadow, space, type } from '../../ui/theme';
import { useToast } from '../../ui/toast';

const ItemTile = React.memo(function ItemTile({ item, inCart, onAdd }: { item: Item; inCart: number; onAdd: (i: Item) => void }) {
  const low = item.stockMilli <= 0;
  return (
    <Tap onPress={() => onAdd(item)} haptic accessibilityLabel={item.name} style={{
      flex: 1, margin: 5, backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, minHeight: 92,
      borderWidth: 2, borderColor: inCart ? colors.primary : 'transparent', ...shadow,
    }}>
      <Text style={type.bodyStrong} numberOfLines={2}>{item.name}</Text>
      <View style={[styles.row, { justifyContent: 'space-between', marginTop: 'auto' }]}>
        <Text style={[type.small, { color: colors.inkSoft }]}>{formatRupees(item.pricePaise)}{item.unit !== 'pcs' ? `/${item.unit}` : ''}</Text>
        {inCart ? <Badge label={formatQty(inCart, item.unit)} tone="primary" /> : low ? <Badge label="0" tone="danger" /> : null}
      </View>
    </Tap>
  );
});

export default function BillScreen() {
  const store = useStoreInstance();
  const t = useT();
  const toast = useToast();
  const params = useLocalSearchParams<{ voice?: string }>();
  const items = useAppState((s) => s.items);
  const customers = useAppState((s) => s.customers);
  const settings = useAppState((s) => s.settings);
  const [cart, setCart] = useState<Cart>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<ChainRecord | null>(null);

  useEffect(() => { if (params.voice) setVoiceOpen(true); }, [params.voice]);

  const categories = useMemo(() => Array.from(new Set(items.map((i) => i.category))), [items]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => (!category || i.category === category) &&
      (!q || i.name.toLowerCase().includes(q) || (i.hi ?? '').includes(q) || (i.aliases ?? []).some((a) => a.includes(q))));
  }, [items, query, category]);
  const qtyBySku = useMemo(() => new Map(cart.map((l) => [l.sku, l.qtyMilli])), [cart]);
  const onAdd = useCallback((i: Item) => setCart((c) => addToCart(c, i)), []);
  const total = cartTotal(cart);

  const save = async () => {
    setSaving(true);
    try {
      const rec = await store.saveBill(cart, mode, mode === 'udhaar' ? customerId : null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setReviewOpen(false);
      setSaved(rec);
      setCart([]);
      setCustomerId(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'danger');
    } finally {
      setSaving(false);
    }
  };

  const names = useMemo(() => new Map(items.map((i) => [i.sku, i])), [items]);
  const receipt = (r: ChainRecord) => [
    `${settings.shopName || t('appName')}`,
    new Date(r.bill.createdAt).toLocaleString('en-IN'),
    ...r.bill.items.map((l) => `${names.get(l.sku)?.name ?? l.sku} × ${formatQty(l.qtyMilli, names.get(l.sku)?.unit ?? 'pcs')} = ${formatRupees(lineTotal(l))}`),
    `${t('total')}: ${formatRupees(r.bill.totalPaise)} (${r.bill.paymentMode.toUpperCase()})`,
    `Bill #${r.entry.seq} · hash ${r.entryHash.slice(0, 12)}…`,
  ].join('\n');
  const upiUri = (r: ChainRecord) => `upi://pay?pa=${encodeURIComponent(settings.upiId)}&pn=${encodeURIComponent(settings.shopName)}&am=${(r.bill.totalPaise / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Bill ' + r.entry.seq)}`;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
        <View style={[styles.row, { justifyContent: 'space-between', marginBottom: space.md }]}>
          <Text style={type.display}>{t('bill')}</Text>
          <Tap onPress={() => setVoiceOpen(true)} haptic accessibilityLabel={t('voiceBill')} style={[styles.row, {
            backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: space.lg, height: 44,
          }]}>
            <Ionicons name="mic" size={20} color="#fff" />
            <Text style={[type.bodyStrong, { color: '#fff', marginLeft: 6 }]}>{t('voiceBill')}</Text>
          </Tap>
        </View>
        <View style={[styles.row, { backgroundColor: colors.card, borderRadius: radius.md, paddingHorizontal: space.md, height: 48, borderWidth: 1, borderColor: colors.line }]}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput value={query} onChangeText={setQuery} placeholder={t('searchItems')} placeholderTextColor={colors.muted}
            style={{ flex: 1, marginLeft: 8, fontSize: 16, color: colors.ink }} accessibilityLabel={t('searchItems')} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.md, marginBottom: space.sm }}>
          <Chip label={t('all')} selected={!category} onPress={() => setCategory(null)} />
          {categories.map((c) => (
            <Chip key={c} label={(settings.lang === 'hi' ? CATEGORY_LABELS[c]?.hi : CATEGORY_LABELS[c]?.en) ?? c} selected={category === c}
              icon={CATEGORY_LABELS[c]?.icon as never} onPress={() => setCategory(category === c ? null : c)} />
          ))}
        </ScrollView>
      </View>
      <FlatList
        data={visible}
        keyExtractor={(i) => i.sku}
        numColumns={2}
        contentContainerStyle={{ paddingHorizontal: space.lg - 5, paddingBottom: 160 }}
        renderItem={({ item }) => <ItemTile item={item} inCart={qtyBySku.get(item.sku) ?? 0} onAdd={onAdd} />}
        initialNumToRender={14}
        windowSize={7}
      />

      {cart.length > 0 && (
        <Tap onPress={() => setReviewOpen(true)} haptic style={{
          position: 'absolute', left: space.lg, right: space.lg, bottom: space.md, backgroundColor: colors.ink,
          borderRadius: radius.lg, padding: space.lg, flexDirection: 'row', alignItems: 'center', ...shadow,
        }}>
          <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '800' }}>{cart.length}</Text>
          </View>
          <Text style={[type.bodyStrong, { color: '#fff', marginLeft: space.md, flex: 1 }]}>{t('cart')}</Text>
          <Text style={[type.title, type.number, { color: '#fff' }]}>{formatRupees(total)}</Text>
          <Ionicons name="chevron-up" size={20} color="#fff" style={{ marginLeft: 8 }} />
        </Tap>
      )}

      <Sheet visible={reviewOpen} onClose={() => setReviewOpen(false)} title={t('cart')}>
        {cart.map((l) => (
          <View key={l.sku} style={[styles.row, { paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line }]}>
            <View style={{ flex: 1 }}>
              <Text style={type.bodyStrong} numberOfLines={1}>{l.name}</Text>
              <Text style={type.small}>{formatRupees(lineTotal(l))}</Text>
            </View>
            <Stepper value={formatQty(l.qtyMilli, l.unit)}
              onMinus={() => setCart((c) => setQty(c, l.sku, l.qtyMilli - stepFor(l.unit)))}
              onPlus={() => setCart((c) => setQty(c, l.sku, l.qtyMilli + stepFor(l.unit)))} />
          </View>
        ))}
        <View style={[styles.row, { justifyContent: 'space-between', marginVertical: space.lg }]}>
          <Text style={type.heading}>{t('total')}</Text>
          <Text style={[type.display, type.number]}>{formatRupees(total)}</Text>
        </View>
        <Segmented<PaymentMode> value={mode} onChange={setMode} options={[
          { value: 'cash', label: t('cash'), icon: 'cash-outline' },
          { value: 'upi', label: t('upi'), icon: 'qr-code-outline' },
          { value: 'udhaar', label: t('udhaar'), icon: 'book-outline' },
        ]} />
        {mode === 'udhaar' && (
          <View style={{ marginTop: space.md }}>
            <Text style={[type.label, { marginBottom: 6 }]}>{t('chooseCustomer')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {customers.map((c) => <Chip key={c.customerId} label={c.name} selected={customerId === c.customerId} onPress={() => setCustomerId(c.customerId)} />)}
            </ScrollView>
          </View>
        )}
        <Button title={`${t('saveBill')} · ${formatRupees(total)}`} icon="checkmark-circle" onPress={save} loading={saving}
          disabled={!cart.length || (mode === 'udhaar' && !customerId)} style={{ marginTop: space.lg }} testID="save-bill" />
      </Sheet>

      <Sheet visible={!!saved} onClose={() => setSaved(null)}>
        {saved && (
          <View style={{ alignItems: 'center' }}>
            <IconCircle name="checkmark" tone="success" size={64} />
            <Text style={[type.title, { marginTop: space.md }]}>{t('billSaved')}</Text>
            <Text style={[type.display, type.number, { marginVertical: space.sm }]}>{formatRupees(saved.bill.totalPaise)}</Text>
            <Badge label={`#${saved.entry.seq} · ${saved.entryHash.slice(0, 10)}…`} icon="shield-checkmark" tone="success" />
            {saved.bill.paymentMode === 'upi' && settings.upiId ? (
              <View style={{ alignItems: 'center', marginTop: space.lg, backgroundColor: '#fff', padding: space.lg, borderRadius: radius.lg }}>
                <QRCode value={upiUri(saved)} size={180} />
                <Text style={[type.small, { marginTop: space.sm }]}>{t('scanToPay')}</Text>
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', marginTop: space.lg, gap: space.sm, alignSelf: 'stretch' }}>
              <Button title={t('shareReceipt')} icon="share-social-outline" variant="secondary" style={{ flex: 1 }}
                onPress={() => Share.share({ message: receipt(saved) }).catch(() => undefined)} />
              <Button title={t('done')} style={{ flex: 1 }} onPress={() => setSaved(null)} />
            </View>
          </View>
        )}
      </Sheet>

      <VoiceSheet visible={voiceOpen} onClose={() => setVoiceOpen(false)}
        onAdd={(lines) => {
          setCart((c) => lines.reduce((acc, l) => addToCart(acc, l.item, l.qtyMilli), c));
          if (lines.length) setTimeout(() => setReviewOpen(true), 350); // let the voice sheet close first
        }} />
    </SafeAreaView>
  );
}
