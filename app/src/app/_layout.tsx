import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StoreContext } from '../data/hooks';
import { openRepo } from '../data/openRepo';
import { Store } from '../data/store';
import { colors, type } from '../ui/theme';
import { ToastProvider } from '../ui/toast';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const [store, setStore] = useState<Store | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setStore(await Store.create(await openRepo()));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        SplashScreen.hideAsync().catch(() => undefined);
      }
    })();
  }, []);

  if (!store) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, padding: 24 }}>
        {error ? <Text style={[type.body, { color: colors.danger, textAlign: 'center' }]}>Could not open the shop database: {error}</Text>
          : <ActivityIndicator color={colors.primary} size="large" />}
      </View>
    );
  }

  return (
    <StoreContext.Provider value={store}>
      <SafeAreaProvider>
        <ToastProvider>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="welcome" options={{ animation: 'fade' }} />
            <Stack.Screen name="settings" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="scan" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="ledger" />
            <Stack.Screen name="customer/[id]" />
            <Stack.Screen name="item/[sku]" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          </Stack>
        </ToastProvider>
      </SafeAreaProvider>
    </StoreContext.Provider>
  );
}
