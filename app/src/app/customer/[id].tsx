import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { useAppState, useInsights, useStoreInstance, useT } from '../../data/hooks';
import { formatRupees, parseRupees } from '../../domain/money';
import type { UdhaarTxn } from '../../domain/types';
import { Badge, Button, Card, Field, Screen, Sheet, Tap, styles } from '../../ui/components';
import { colors, space, type } from '../../ui/theme';
import { useToast } from '../../ui/toast';

const DRIVER_TEXT: Record<string, string> = {
  days_since_payment: 'No payment for a long time', pay_ratio_90d: 'Paid back little in the last 90 days',
  utilisation: 'Close to the credit limit', avg_days_to_repay: 'Usually pays late', late_payments: 'Several late payments',
  tenure_days: 'New customer', reminders_ignored: 'Ignored reminders',
};

export default function CustomerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const store = useStoreInstance();
  const t = useT();
  const toast = useToast();
  const insights = useInsights();
  const customer = useAppState((s) => s.customers.find((c) => c.customerId === id));
  const all = useAppState((s) => s.udhaar);
  const settings = useAppState((s) => s.settings);
  const txns = useMemo(() => all.filter((u) => u.customerId === id).sort((a, b) => b.ts - a.ts), [all, id]);
  const balance = txns.reduce((s, u) => s + (u.kind === 'credit' ? u.amountPaise : -u.amountPaise), 0);
  const risk = insights?.udhaar.find((r) => r.customerId === id);
  const [entry, setEntry] = useState<UdhaarTxn['kind'] | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  if (!customer) {
    return <Screen title="—"><Button title={t('done')} onPress={() => router.back()} /></Screen>;
  }

  const save = async () => {
    const paise = parseRupees(amount);
    if (!paise || !entry) { toast('Enter an amount', 'danger'); return; }
    if (busy) return;
    setBusy(true);
    try {
      await store.recordUdhaar(customer.customerId, entry, paise);
      toast(entry === 'payment' ? `${formatRupees(paise)} ✓` : `${t('giveCredit')} ✓`);
      setEntry(null);
      setAmount('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const remind = async () => {
    const upi = settings.upiId ? `\nPay by UPI: upi://pay?pa=${encodeURIComponent(settings.upiId)}&pn=${encodeURIComponent(settings.shopName)}&am=${(balance / 100).toFixed(2)}&cu=INR` : '';
    const msg = `Namaste ${customer.name} ji 🙏\nYour pending amount at ${settings.shopName} is ${formatRupees(balance)}.${upi}\nThank you!`;
    const digits = (customer.phone ?? '').replace(/\D/g, '');
    const url = digits ? `https://wa.me/${digits.length === 10 ? '91' + digits : digits}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    try {
      await Linking.openURL(url);
      await store.markReminderSent(customer.customerId);
    } catch {
      toast('WhatsApp is not installed', 'danger');
    }
  };

  return (
    <Screen>
      <View style={[styles.row, { marginBottom: space.lg }]}>
        <Tap onPress={() => router.back()} accessibilityLabel="back" style={{ padding: 4, marginRight: space.sm }}>
          <Ionicons name="arrow-back" size={24} color={colors.ink} />
        </Tap>
        <Text style={[type.title, { flex: 1 }]} numberOfLines={1}>{customer.name}</Text>
      </View>
      <Card>
        <Text style={type.label}>{t('outstanding')}</Text>
        <Text style={[type.display, type.number, { color: balance > 0 ? colors.danger : colors.success, marginTop: 4 }]}>{formatRupees(Math.max(0, balance))}</Text>
        {risk && (
          <View style={{ marginTop: space.md }}>
            <Badge label={`${t('risk')}: ${t(risk.band)} (${Math.round(risk.risk * 100)}%)`} tone={risk.band === 'high' ? 'danger' : risk.band === 'medium' ? 'accent' : 'success'} />
            {risk.drivers.map((d) => <Text key={d} style={[type.small, { marginTop: 4 }]}>• {DRIVER_TEXT[d] ?? d}</Text>)}
            <Text style={[type.small, { marginTop: space.sm, fontStyle: 'italic' }]}>Decision support only. Based on payment behaviour, never on who the customer is.</Text>
          </View>
        )}
      </Card>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button title={t('giveCredit')} icon="arrow-up-circle-outline" variant="secondary" style={{ flex: 1 }} onPress={() => setEntry('credit')} />
        <Button title={t('receivePayment')} icon="arrow-down-circle-outline" style={{ flex: 1 }} onPress={() => setEntry('payment')} />
      </View>
      {balance > 0 && <Button title={t('sendReminder')} icon="logo-whatsapp" variant="ghost" style={{ marginTop: space.sm }} onPress={remind} />}
      <Card style={{ marginTop: space.md, paddingVertical: space.sm }}>
        {txns.slice(0, 50).map((u, i) => (
          <View key={u.id} style={[styles.row, { paddingVertical: space.sm, borderTopWidth: i ? 1 : 0, borderTopColor: colors.line }]}>
            <Ionicons name={u.kind === 'credit' ? 'arrow-up' : 'arrow-down'} size={18} color={u.kind === 'credit' ? colors.danger : colors.success} />
            <Text style={[type.body, { flex: 1, marginLeft: space.sm }]}>{new Date(u.ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</Text>
            <Text style={[type.bodyStrong, type.number, { color: u.kind === 'credit' ? colors.danger : colors.success }]}>
              {u.kind === 'credit' ? '+' : '−'}{formatRupees(u.amountPaise)}
            </Text>
          </View>
        ))}
      </Card>
      <Sheet visible={!!entry} onClose={() => setEntry(null)} title={entry === 'credit' ? t('giveCredit') : t('receivePayment')}>
        <Field label={t('amount')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" autoFocus />
        <Button title={t('save')} icon="checkmark" onPress={save} loading={busy} />
      </Sheet>
    </Screen>
  );
}
