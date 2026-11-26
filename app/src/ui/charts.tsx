/** Lightweight SVG charts (no heavy chart library). */
import { useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { colors, type } from './theme';

function path(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

export function useWidth(initial = 300): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(initial);
  return [w, (e) => setW(e.nativeEvent.layout.width)];
}

/** History (solid) + forecast (dashed, shaded band). Festival days marked. */
export function ForecastChart({ history, forecast, sigma, markers = [], height = 170 }: {
  history: number[]; forecast: number[]; sigma: number; markers?: number[]; height?: number;
}) {
  const [width, onLayout] = useWidth();
  const all = [...history, ...forecast.map((f) => f + sigma)];
  const max = Math.max(1, ...all) * 1.1;
  const n = history.length + forecast.length;
  const x = (i: number) => (i / Math.max(n - 1, 1)) * (width - 8) + 4;
  const y = (v: number) => height - 18 - (v / max) * (height - 30);
  const hist = history.map((v, i) => [x(i), y(v)] as [number, number]);
  const startF = history.length - 1;
  const fc = [[x(startF), y(history[startF] ?? 0)] as [number, number], ...forecast.map((v, i) => [x(startF + 1 + i), y(v)] as [number, number])];
  const upper = forecast.map((v, i) => [x(startF + 1 + i), y(v + sigma)] as [number, number]);
  const lower = forecast.map((v, i) => [x(startF + 1 + i), y(Math.max(0, v - sigma))] as [number, number]).reverse();
  const band = upper.length ? `${path(upper)} ${lower.map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`).join(' ')} Z` : '';
  return (
    <View onLayout={onLayout}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.primary} stopOpacity="0.18" />
            <Stop offset="1" stopColor={colors.primary} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        {markers.map((m) => (
          <Rect key={m} x={x(startF + 1 + m) - 4} y={8} width={8} height={height - 26} fill={colors.accentSoft} rx={3} />
        ))}
        <Line x1={x(startF)} x2={x(startF)} y1={8} y2={height - 18} stroke={colors.line} strokeDasharray="3,4" />
        {hist.length > 1 && <Path d={`${path(hist)} L${x(startF)},${height - 18} L${x(0)},${height - 18} Z`} fill="url(#g)" />}
        {hist.length > 1 && <Path d={path(hist)} stroke={colors.primary} strokeWidth={2.2} fill="none" />}
        {band ? <Path d={band} fill={colors.accent} opacity={0.12} /> : null}
        <Path d={path(fc)} stroke={colors.accent} strokeWidth={2.4} strokeDasharray="6,5" fill="none" />
        {fc.length > 1 && <Circle cx={fc[fc.length - 1][0]} cy={fc[fc.length - 1][1]} r={4} fill={colors.accent} />}
      </Svg>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={type.small}>−{history.length}d</Text>
        <Text style={type.small}>today</Text>
        <Text style={type.small}>+{forecast.length}d</Text>
      </View>
    </View>
  );
}

export function Sparkline({ values, dashedFrom, height = 56, color = colors.primary }: { values: number[]; dashedFrom?: number; height?: number; color?: string }) {
  const [width, onLayout] = useWidth(200);
  const max = Math.max(1, ...values);
  const x = (i: number) => (i / Math.max(values.length - 1, 1)) * (width - 6) + 3;
  const y = (v: number) => height - 4 - (v / max) * (height - 8);
  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const split = dashedFrom ?? values.length;
  return (
    <View onLayout={onLayout}>
      <Svg width={width} height={height}>
        <Path d={path(pts.slice(0, split))} stroke={color} strokeWidth={2.2} fill="none" />
        {split < values.length && <Path d={path(pts.slice(split - 1))} stroke={colors.accent} strokeWidth={2.2} strokeDasharray="5,4" fill="none" />}
      </Svg>
    </View>
  );
}

export function Bars({ data, height = 120 }: { data: { label: string; value: number; tone?: string }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: 8 }}>
      {data.map((d) => (
        <View key={d.label} style={{ flex: 1, alignItems: 'center' }}>
          <View style={{ width: '100%', height: Math.max(4, (d.value / max) * (height - 22)), backgroundColor: d.tone ?? colors.primary, borderRadius: 6 }} />
          <Text style={[type.small, { fontSize: 11, marginTop: 4 }]} numberOfLines={1}>{d.label}</Text>
        </View>
      ))}
    </View>
  );
}
