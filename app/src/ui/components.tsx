import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator, Animated, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput,
  View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, shadow, space, toneColors, type, type Tone } from './theme';

export type IconName = keyof typeof Ionicons.glyphMap;

const LAYOUT_KEYS = ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'width', 'margin', 'marginTop', 'marginBottom',
  'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'position', 'left', 'right', 'top', 'bottom'] as const;

export function splitLayout(style: StyleProp<ViewStyle>): { outer: ViewStyle; inner: ViewStyle } {
  const flat = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = { ...flat };
  for (const k of LAYOUT_KEYS) {
    if (flat[k] !== undefined) {
      outer[k] = flat[k];
      delete inner[k];
    }
  }
  if (outer.flex !== undefined || outer.width !== undefined) inner.flex = 1;
  return { outer: outer as ViewStyle, inner: inner as ViewStyle };
}

/** Pressable with a springy scale + optional haptic: the base of every tappable thing. */
export function Tap({ onPress, children, style, haptic = false, disabled, accessibilityLabel, testID }: {
  onPress?: () => void; children: React.ReactNode; style?: StyleProp<ViewStyle>; haptic?: boolean; disabled?: boolean;
  accessibilityLabel?: string; testID?: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.spring(scale, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  // Layout props must live on the Pressable (the flex child); visuals stay on the animated view.
  const { outer, inner } = splitLayout(style);
  return (
    <Pressable
      style={outer}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPressIn={() => to(0.96)}
      onPressOut={() => to(1)}
      onPress={() => {
        if (haptic) Haptics.selectionAsync().catch(() => undefined);
        onPress?.();
      }}
    >
      <Animated.View style={[inner, { transform: [{ scale }] }, disabled && { opacity: 0.5 }]}>{children}</Animated.View>
    </Pressable>
  );
}

export function Card({ children, style, onPress }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const body = <View style={[styles.card, style]}>{children}</View>;
  return onPress ? <Tap onPress={onPress}>{body}</Tap> : body;
}

export function Button({ title, onPress, icon, variant = 'primary', loading, disabled, style, testID }: {
  title: string; onPress: () => void; icon?: IconName; variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; testID?: string;
}) {
  const v = {
    primary: { bg: colors.primary, fg: '#fff', border: colors.primary },
    secondary: { bg: colors.card, fg: colors.primary, border: colors.line },
    ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent' },
    danger: { bg: colors.dangerSoft, fg: colors.danger, border: colors.dangerSoft },
  }[variant];
  return (
    <Tap onPress={onPress} disabled={disabled || loading} haptic testID={testID} accessibilityLabel={title}
      style={[styles.button, { backgroundColor: v.bg, borderColor: v.border }, style]}>
      {loading ? <ActivityIndicator color={v.fg} /> : (
        <>
          {icon && <Ionicons name={icon} size={18} color={v.fg} style={{ marginRight: 8 }} />}
          <Text style={[type.bodyStrong, { color: v.fg }]}>{title}</Text>
        </>
      )}
    </Tap>
  );
}

export function Chip({ label, selected, onPress, icon }: { label: string; selected?: boolean; onPress?: () => void; icon?: IconName }) {
  return (
    <Tap onPress={onPress} haptic style={[styles.chip, selected && { backgroundColor: colors.ink, borderColor: colors.ink }]}>
      {icon && <Ionicons name={icon} size={14} color={selected ? '#fff' : colors.inkSoft} style={{ marginRight: 6 }} />}
      <Text style={[type.small, { color: selected ? '#fff' : colors.inkSoft, fontWeight: '600' }]}>{label}</Text>
    </Tap>
  );
}

export function Badge({ label, tone = 'neutral', icon }: { label: string; tone?: Tone; icon?: IconName }) {
  const c = toneColors[tone];
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      {icon && <Ionicons name={icon} size={12} color={c.fg} style={{ marginRight: 4 }} />}
      <Text style={{ color: c.fg, fontSize: 12, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={type.label}>{label}</Text>
      <Text style={[type.title, type.number, { marginTop: 4 }, tone && { color: toneColors[tone].fg }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {sub ? <Text style={[type.small, { marginTop: 2 }]}>{sub}</Text> : null}
    </View>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={type.heading}>{title}</Text>
      {action ? <Tap onPress={onAction}><Text style={[type.small, { color: colors.primary, fontWeight: '700' }]}>{action}</Text></Tap> : null}
    </View>
  );
}

export function EmptyState({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={{ alignItems: 'center', padding: space.xl }}>
      <View style={styles.emptyIcon}><Ionicons name={icon} size={28} color={colors.primary} /></View>
      <Text style={[type.body, { color: colors.muted, textAlign: 'center', marginTop: space.md }]}>{text}</Text>
    </View>
  );
}

export function Screen({ children, title, right, scroll = true, padded = true }: {
  children: React.ReactNode; title?: string; right?: React.ReactNode; scroll?: boolean; padded?: boolean;
}) {
  const header = title ? (
    <View style={styles.screenHeader}>
      <Text style={type.display}>{title}</Text>
      {right}
    </View>
  ) : null;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      {scroll ? (
        <ScrollView contentContainerStyle={[padded && { padding: space.lg, paddingBottom: 120 }]} keyboardShouldPersistTaps="handled">
          {header}
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, padded && { paddingHorizontal: space.lg }]}>
          {header}
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}

export function Field({ label, style, ...props }: TextInputProps & { label: string; style?: StyleProp<TextStyle> }) {
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={[type.label, { marginBottom: 6 }]}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} style={[styles.input, style]} accessibilityLabel={label} {...props} />
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string; icon?: IconName }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Tap key={o.value} onPress={() => onChange(o.value)} haptic style={[styles.segment, on && styles.segmentOn]}>
            {o.icon && <Ionicons name={o.icon} size={16} color={on ? colors.ink : colors.muted} style={{ marginRight: 6 }} />}
            <Text numberOfLines={1} adjustsFontSizeToFit style={[type.small, { fontWeight: '700', color: on ? colors.ink : colors.muted }]}>{o.label}</Text>
          </Tap>
        );
      })}
    </View>
  );
}

export function Stepper({ value, onMinus, onPlus }: { value: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <View style={styles.stepper}>
      <Tap onPress={onMinus} haptic style={styles.stepBtn} accessibilityLabel="decrease"><Ionicons name="remove" size={18} color={colors.ink} /></Tap>
      <Text style={[type.bodyStrong, type.number, { minWidth: 56, textAlign: 'center' }]}>{value}</Text>
      <Tap onPress={onPlus} haptic style={styles.stepBtn} accessibilityLabel="increase"><Ionicons name="add" size={18} color={colors.ink} /></Tap>
    </View>
  );
}

/** Bottom sheet built on Modal with a fading backdrop and sliding panel. */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const y = useRef(new Animated.Value(400)).current;
  useEffect(() => {
    if (visible) Animated.spring(y, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    else y.setValue(400);
  }, [visible, y]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="close" />
        <Animated.View style={[styles.sheet, { transform: [{ translateY: y }] }]}>
          <View style={styles.grabber} />
          {title ? <Text style={[type.title, { marginBottom: space.md }]}>{title}</Text> : null}
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 560 }}>{children}</ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function ProgressBar({ value, tone = 'primary' }: { value: number; tone?: Tone }) {
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${Math.max(3, Math.min(100, value * 100))}%`, backgroundColor: toneColors[tone].fg }]} />
    </View>
  );
}

export const IconCircle = ({ name, tone = 'primary', size = 40 }: { name: IconName; tone?: Tone; size?: number }) => (
  <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: toneColors[tone].bg, alignItems: 'center', justifyContent: 'center' }}>
    <Ionicons name={name} size={size * 0.5} color={toneColors[tone].fg} />
  </View>
);

export const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space.lg, marginBottom: space.md, ...shadow },
  button: { height: 50, borderRadius: radius.md, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 36, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, marginRight: space.sm },
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: space.lg, marginBottom: space.sm },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  screenHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.lg, marginTop: space.sm },
  input: { height: 50, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, paddingHorizontal: space.md, fontSize: 16, color: colors.ink },
  segmented: { flexDirection: 'row', backgroundColor: '#ECE9E1', borderRadius: radius.md, padding: 4 },
  segment: { flex: 1, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  segmentOn: { backgroundColor: colors.card, ...shadow },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1EFE9', borderRadius: radius.pill },
  stepBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: space.lg, paddingBottom: space.xxl },
  grabber: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: space.md },
  track: { height: 6, borderRadius: 3, backgroundColor: '#EFECE4', overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
