import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import type { ScanLine } from '../api/client';
import { useAppState, useStoreInstance, useT } from '../data/hooks';
import { bestMatches } from '../domain/match';
import { formatQty, formatRupees } from '../domain/money';
import type { Item } from '../domain/types';
import { Badge, Button, Card, Chip, IconCircle, Screen, Sheet, Tap, styles } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import { useToast } from '../ui/toast';

/** What Textract AnalyzeExpense returns for a typical distributor bill (offline demo). */
const SAMPLE: ScanLine[] = [
  { description: 'PARLE-G 80G', qtyMilli: 48000, unitPricePaise: 820, amountPaise: 39360 },
  { description: 'TATA SALT 1KG', qtyMilli: 20000, unitPricePaise: 2400, amountPaise: 48000 },
  { description: 'MAGGI NOODLES 70G', qtyMilli: 48000, unitPricePaise: 1150, amountPaise: 55200 },
  { description: 'SURF EXCEL EASY WASH 1KG', qtyMilli: 12000, unitPricePaise: 12200, amountPaise: 146400 },
  { description: 'AGARBATTI MOGRA', qtyMilli: 24000, unitPricePaise: 2200, amountPaise: 52800 },
  { description: 'CLAY DIYA 12PC', qtyMilli: 20000, unitPricePaise: 3500, amountPaise: 70000 },
  { description: 'FREIGHT CHARGES', qtyMilli: 1000, unitPricePaise: 5000, amountPaise: 5000 },
];

interface Row { line: ScanLine; sku: string | null; score: number; qtyMilli: number; include: boolean }

export default function Scan() {
  const store = useStoreInstance();
  const t = useT();
  const toast = useToast();
  const items = useAppState((s) => s.items);
  const signedIn = useAppState((s) => !!s.settings.email);
  const [busy, setBusy] = useState(false);
  const [vendor, setVendor] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const byS = useMemo(() => new Map(items.map((i) => [i.sku, i])), [items]);

  const load = (lines: ScanLine[], v: string | null) => {
    setVendor(v);
    setRows(lines.map((line) => {
      const [m] = bestMatches(line.description, items, 1, 0.6);
      return { line, sku: m?.item.sku ?? null, score: m?.score ?? 0, qtyMilli: line.qtyMilli, include: !!m };
    }));
  };

  const pick = async (camera: boolean) => {
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { toast('Permission needed', 'accent'); return; }
    const res = camera
      ? await ImagePicker.launchCameraAsync({ quality: 0.6, mediaTypes: ['images'] })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.6, mediaTypes: ['images'] });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    if (asset.fileSize && asset.fileSize > 5 * 1024 * 1024) { toast('Photo is larger than 5 MB', 'danger'); return; }
    setBusy(true);
    try {
      const out = await store.scanInvoice(asset.uri, asset.mimeType === 'image/png' ? 'image/png' : 'image/jpeg');
      if (!out.lines.length) toast('No line items found. Try a clearer photo.', 'accent');
      load(out.lines, out.vendor);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not read invoice', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!rows) return;
    const lines = rows.filter((r) => r.include && r.sku).map((r) => {
      const it = byS.get(r.sku!)!;
      // invoices count packs/pieces; loose items (kg) keep the invoice quantity
      return { sku: it.sku, qtyMilli: r.qtyMilli, costPaise: r.line.unitPricePaise };
    });
    try {
      const n = await store.receiveStock(lines);
      toast(`${n} items updated`);
      router.back();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update stock', 'danger');
    }
  };

  const candidates: Item[] = useMemo(() => {
    if (picking === null || !rows) return [];
    const q = search.trim();
    return q ? bestMatches(q, items, 8, 0.3).map((m) => m.item) : bestMatches(rows[picking].line.description, items, 8, 0.2).map((m) => m.item);
  }, [picking, rows, search, items]);

  return (
    <Screen title={t('scanTitle')} right={<Tap onPress={() => router.back()} accessibilityLabel="close"><Ionicons name="close" size={28} color={colors.ink} /></Tap>}>
      {!rows && !busy && (
        <>
          <Card style={{ alignItems: 'center', padding: space.xl }}>
            <IconCircle name="document-text-outline" size={72} tone="info" />
            <Text style={[type.body, { textAlign: 'center', marginTop: space.md }]}>Amazon Textract reads item, quantity and price from a supplier bill photo. You confirm, and stock updates.</Text>
          </Card>
          {signedIn ? (
            <View style={{ gap: space.sm }}>
              <Button title={t('takePhoto')} icon="camera-outline" onPress={() => pick(true)} />
              <Button title={t('fromGallery')} icon="images-outline" variant="secondary" onPress={() => pick(false)} />
            </View>
          ) : <Text style={[type.small, { textAlign: 'center', marginBottom: space.md }]}>{t('offlineScan')}</Text>}
          <Button title={t('sampleInvoice')} icon="flask-outline" variant="ghost" onPress={() => load(SAMPLE, 'Gupta Distributors (sample)')} style={{ marginTop: space.sm }} />
        </>
      )}
      {busy && <Card style={{ alignItems: 'center', padding: space.xxl }}><ActivityIndicator color={colors.primary} size="large" /><Text style={[type.body, { marginTop: space.md }]}>{t('reading')}</Text></Card>}
      {rows && (
        <>
          {vendor ? <Text style={[type.heading, { marginBottom: space.md }]}>{vendor}</Text> : null}
          {rows.map((r, i) => {
            const it = r.sku ? byS.get(r.sku) : undefined;
            return (
              <Card key={i} style={{ opacity: r.include ? 1 : 0.55 }}>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={type.small}>{r.line.description}</Text>
                    <Tap onPress={() => { setPicking(i); setSearch(''); }}>
                      <Text style={[type.bodyStrong, { color: it ? colors.ink : colors.danger, marginTop: 2 }]}>{it ? it.name : t('notMatched')}</Text>
                    </Tap>
                  </View>
                  <Tap onPress={() => setRows(rows.map((x, k) => (k === i ? { ...x, include: !x.include && !!x.sku } : x)))} accessibilityLabel="include">
                    <Ionicons name={r.include ? 'checkbox' : 'square-outline'} size={26} color={r.include ? colors.primary : colors.muted} />
                  </Tap>
                </View>
                <View style={[styles.row, { marginTop: space.sm, gap: space.sm }]}>
                  <Badge label={`+${formatQty(r.qtyMilli, it?.unit ?? 'pcs')}`} tone="primary" />
                  {r.line.unitPricePaise ? <Badge label={`${formatRupees(r.line.unitPricePaise)} each`} tone="neutral" /> : null}
                  {it ? <Badge label={`${t('matched')} ${Math.round(r.score * 100)}%`} tone={r.score > 0.85 ? 'success' : 'accent'} /> : null}
                </View>
              </Card>
            );
          })}
          <Button title={`${t('addToStock')} (${rows.filter((r) => r.include).length})`} icon="cube-outline" onPress={apply} disabled={!rows.some((r) => r.include)} />
        </>
      )}
      <Sheet visible={picking !== null} onClose={() => setPicking(null)} title={rows && picking !== null ? rows[picking].line.description : ''}>
        <TextInput value={search} onChangeText={setSearch} placeholder={t('searchItems')} placeholderTextColor={colors.muted}
          style={{ height: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, paddingHorizontal: space.md, marginBottom: space.md, color: colors.ink }} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {candidates.map((c) => (
            <View key={c.sku} style={{ marginBottom: space.sm }}>
              <Chip label={c.name} onPress={() => {
                if (picking !== null && rows) setRows(rows.map((x, k) => (k === picking ? { ...x, sku: c.sku, score: 1, include: true } : x)));
                setPicking(null);
              }} />
            </View>
          ))}
        </View>
      </Sheet>
    </Screen>
  );
}
