import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useAppState, useLedgerStatus, useStoreInstance } from '../data/hooks';
import { verifyChain, type VerifyReport } from '../domain/ledger';
import { formatRupees } from '../domain/money';
import { Badge, Button, Card, IconCircle, Screen, Tap, styles } from '../ui/components';
import { colors, radius, space, type } from '../ui/theme';
import { useToast } from '../ui/toast';

const EXPLAIN: Record<string, string> = {
  SEQ_GAP: 'A bill was deleted or inserted.', PREV_MISMATCH: 'Bills were reordered.', PAYLOAD_MISMATCH: 'A bill was edited after saving.',
  HASH_MISMATCH: 'A ledger entry was altered.', BAD_SIGNATURE: 'A signature does not match: the record was forged.', SHOP_MISMATCH: 'An entry belongs to another shop.',
};

export default function Ledger() {
  const store = useStoreInstance();
  const toast = useToast();
  const chain = useAppState((s) => s.chain);
  const settings = useAppState((s) => s.settings);
  const status = useLedgerStatus();
  const [full, setFull] = useState<VerifyReport | null>(null);
  const [demo, setDemo] = useState<VerifyReport | null>(null);
  const [cloud, setCloud] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signed = chain.filter((r) => r.signature).length;

  const verifyAll = () => {
    setBusy(true);
    setTimeout(() => {
      setFull(store.verifyLocal('all'));
      setBusy(false);
    }, 30);
  };

  /** Viva demo: edit one bill in memory (never on disk) and show that verification catches it. */
  const tamperDemo = () => {
    if (chain.length < 3) { toast('Make a few bills first', 'accent'); return; }
    const i = Math.floor(chain.length / 2);
    const copy = chain.map((r, k) => (k === i ? { ...r, bill: { ...r.bill, totalPaise: r.bill.totalPaise - 100 } } : r));
    setDemo(verifyChain(settings.shopId, copy, settings.publicKey ?? undefined, 'latest'));
  };

  const verifyCloud = async () => {
    setBusy(true);
    try {
      const r = await store.api().verifyLedger();
      setCloud(r.valid ? `Cloud (Rust signer): ${r.checked} entries valid ✓` : `Cloud found a problem at #${r.failure?.seq}: ${r.failure?.code}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Cloud verify failed', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const valid = status?.valid ?? true;
  return (
    <Screen>
      <View style={[styles.row, { marginBottom: space.lg }]}>
        <Tap onPress={() => router.back()} accessibilityLabel="back" style={{ padding: 4, marginRight: space.sm }}>
          <Ionicons name="arrow-back" size={24} color={colors.ink} />
        </Tap>
        <Text style={type.title}>Tamper-proof ledger</Text>
      </View>
      <Card style={{ alignItems: 'center', paddingVertical: space.xl }}>
        <IconCircle name={valid ? 'shield-checkmark' : 'warning'} tone={valid ? 'success' : 'danger'} size={72} />
        <Text style={[type.title, { marginTop: space.md }]}>{valid ? 'All bills intact' : 'Tampering detected'}</Text>
        <Text style={type.small}>{chain.length.toLocaleString('en-IN')} bills · {signed.toLocaleString('en-IN')} signed by the cloud</Text>
        {status?.failure && <Text style={[type.body, { color: colors.danger, marginTop: space.sm }]}>#{status.failure.seq}: {EXPLAIN[status.failure.code]}</Text>}
      </Card>
      <Card>
        <Text style={type.heading}>How it works</Text>
        {[
          ['link-outline', 'Every bill is hashed (SHA-256) together with the previous bill\'s hash, forming a chain on this phone, even offline.'],
          ['key-outline', 'On sync, a Rust service on AWS checks the chain and signs each entry with Ed25519. Only it holds the key.'],
          ['eye-outline', 'Anyone with the public key can verify. Editing, deleting or reordering any bill breaks the chain.'],
        ].map(([icon, text]) => (
          <View key={icon} style={[styles.row, { marginTop: space.md, alignItems: 'flex-start' }]}>
            <Ionicons name={icon as never} size={20} color={colors.primary} />
            <Text style={[type.body, { marginLeft: space.sm, flex: 1 }]}>{text}</Text>
          </View>
        ))}
      </Card>
      <View style={{ gap: space.sm }}>
        <Button title="Verify every hash and signature" icon="shield-outline" onPress={verifyAll} loading={busy} />
        {settings.email ? <Button title="Verify in the cloud (Rust)" icon="cloud-outline" variant="secondary" onPress={verifyCloud} loading={busy} /> : null}
        <Button title="Tamper demo (edits a copy)" icon="bug-outline" variant="danger" onPress={tamperDemo} />
      </View>
      {full && <Card style={{ marginTop: space.md }}><Text style={type.bodyStrong}>{full.valid ? `✓ ${full.checked} hashes, ${full.signed} signatures verified` : `✗ #${full.failure?.seq}: ${EXPLAIN[full.failure!.code]}`}</Text></Card>}
      {cloud && <Card style={{ marginTop: space.md }}><Text style={type.bodyStrong}>{cloud}</Text></Card>}
      {demo && (
        <Card style={{ marginTop: space.md, backgroundColor: colors.dangerSoft }}>
          <Text style={type.bodyStrong}>Changed bill #{demo.failure?.seq ?? '?'} by ₹1 in a copy →</Text>
          <Text style={[type.body, { color: colors.danger, marginTop: 4 }]}>{demo.failure ? `Detected: ${EXPLAIN[demo.failure.code]}` : 'Not detected'}</Text>
        </Card>
      )}
      <Text style={[type.heading, { marginTop: space.lg, marginBottom: space.sm }]}>Latest entries</Text>
      {chain.slice(-8).reverse().map((r) => (
        <View key={r.entry.seq} style={{ backgroundColor: colors.card, borderRadius: radius.md, padding: space.md, marginBottom: space.sm }}>
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text style={type.bodyStrong}>#{r.entry.seq} · {formatRupees(r.bill.totalPaise)}</Text>
            <Badge label={r.signature ? 'signed' : 'local'} tone={r.signature ? 'success' : 'neutral'} icon={r.signature ? 'key' : 'phone-portrait-outline'} />
          </View>
          <Text style={[type.small, { fontFamily: 'monospace', marginTop: 4 }]}>hash {r.entryHash.slice(0, 24)}…</Text>
          <Text style={[type.small, { fontFamily: 'monospace' }]}>prev {r.entry.prevHash.slice(0, 24)}…</Text>
        </View>
      ))}
      {settings.publicKey ? <Text style={[type.small, { fontFamily: 'monospace', marginTop: space.md }]}>Public key: {settings.publicKey}</Text> : null}
    </Screen>
  );
}
