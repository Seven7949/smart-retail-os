import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { useAppState, useT } from '../../data/hooks';
import { colors } from '../../ui/theme';

type IconName = keyof typeof Ionicons.glyphMap;
const TABS: { name: string; key: 'home' | 'bill' | 'stock' | 'insights' | 'khata'; icon: IconName; active: IconName }[] = [
  { name: 'index', key: 'home', icon: 'home-outline', active: 'home' },
  { name: 'bill', key: 'bill', icon: 'receipt-outline', active: 'receipt' },
  { name: 'stock', key: 'stock', icon: 'cube-outline', active: 'cube' },
  { name: 'insights', key: 'insights', icon: 'sparkles-outline', active: 'sparkles' },
  { name: 'khata', key: 'khata', icon: 'book-outline', active: 'book' },
];

export default function TabsLayout() {
  const onboarded = useAppState((s) => s.settings.onboarded);
  const t = useT();
  if (!onboarded) return <Redirect href="/welcome" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { height: 64, paddingBottom: 8, paddingTop: 6, borderTopColor: colors.line, backgroundColor: colors.card },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: t(tab.key),
            tabBarIcon: ({ focused, color }) => <Ionicons name={focused ? tab.active : tab.icon} size={24} color={color as string} />,
          }}
        />
      ))}
    </Tabs>
  );
}
