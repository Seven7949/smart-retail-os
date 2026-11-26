import { Ionicons } from '@expo/vector-icons';
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, shadow, space, toneColors, type, type Tone } from './theme';

type Show = (message: string, tone?: Tone) => void;
interface ToastState { show: Show; msg: { text: string; tone: Tone } | null; anim: Animated.Value }

const ToastContext = createContext<ToastState | null>(null);
export const useToast = (): Show => useContext(ToastContext)?.show ?? (() => undefined);

const ICONS: Record<Tone, keyof typeof Ionicons.glyphMap> = {
  primary: 'information-circle', accent: 'alert-circle', danger: 'close-circle', success: 'checkmark-circle', info: 'information-circle', neutral: 'information-circle',
};

/**
 * Renders the current toast. Mounted once at the root AND inside every Sheet:
 * an Android Modal is a separate window, so a root-only toast would be hidden
 * behind any open sheet.
 */
export function ToastView() {
  const ctx = useContext(ToastContext);
  const insets = useSafeAreaInsets();
  if (!ctx?.msg) return null;
  const { msg, anim } = ctx;
  return (
    <Animated.View pointerEvents="none" style={{
      position: 'absolute', top: insets.top + 8, left: space.lg, right: space.lg, opacity: anim, zIndex: 100,
      transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-30, 0] }) }],
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.ink, borderRadius: radius.md, padding: space.md, ...shadow }}>
        <Ionicons name={ICONS[msg.tone]} size={20} color={toneColors[msg.tone].bg} />
        <Text style={[type.bodyStrong, { color: '#fff', marginLeft: 10, flex: 1 }]}>{msg.text}</Text>
      </View>
    </Animated.View>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<ToastState['msg']>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback<Show>((text, tone = 'success') => {
    setMsg({ text, tone });
    if (timer.current) clearTimeout(timer.current);
    anim.stopAnimation();
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, bounciness: 6 }).start();
    timer.current = setTimeout(() => Animated.timing(anim, { toValue: 0, duration: 220, useNativeDriver: true })
      .start(({ finished }) => { if (finished) setMsg(null); }), 2600);
  }, [anim]);
  return (
    <ToastContext.Provider value={{ show, msg, anim }}>
      {children}
      <ToastView />
    </ToastContext.Provider>
  );
}
