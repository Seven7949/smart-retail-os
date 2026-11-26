import { Platform } from 'react-native';

export const colors = {
  bg: '#F6F4EF',
  card: '#FFFFFF',
  ink: '#18212F',
  inkSoft: '#3B4556',
  muted: '#6B7280',
  line: '#E8E4DA',
  primary: '#0F766E',
  primaryDark: '#0B5B55',
  primarySoft: '#E3F1EF',
  accent: '#E88B00',
  accentSoft: '#FDF1DC',
  danger: '#C62828',
  dangerSoft: '#FCE8E8',
  success: '#15803D',
  successSoft: '#E2F5E8',
  info: '#1D4ED8',
  infoSoft: '#E5ECFD',
  overlay: 'rgba(15, 23, 42, 0.45)',
} as const;

export type Tone = 'primary' | 'accent' | 'danger' | 'success' | 'info' | 'neutral';

export const toneColors: Record<Tone, { fg: string; bg: string }> = {
  primary: { fg: colors.primary, bg: colors.primarySoft },
  accent: { fg: colors.accent, bg: colors.accentSoft },
  danger: { fg: colors.danger, bg: colors.dangerSoft },
  success: { fg: colors.success, bg: colors.successSoft },
  info: { fg: colors.info, bg: colors.infoSoft },
  neutral: { fg: colors.inkSoft, bg: '#EFEDE7' },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 20, pill: 999 } as const;

export const type = {
  display: { fontSize: 30, fontWeight: '800' as const, letterSpacing: -0.5, color: colors.ink },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.3, color: colors.ink },
  heading: { fontSize: 17, fontWeight: '700' as const, color: colors.ink },
  body: { fontSize: 15, fontWeight: '400' as const, color: colors.ink },
  bodyStrong: { fontSize: 15, fontWeight: '600' as const, color: colors.ink },
  small: { fontSize: 13, fontWeight: '400' as const, color: colors.muted },
  label: { fontSize: 12, fontWeight: '700' as const, letterSpacing: 0.6, color: colors.muted, textTransform: 'uppercase' as const },
  number: { fontVariant: ['tabular-nums' as const] },
};

export const shadow = Platform.select({
  android: { elevation: 2 },
  default: { shadowColor: '#0F172A', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
});
