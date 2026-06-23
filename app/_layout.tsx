import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { useAuthStore } from '../store/auth';

export default function RootLayout() {
  const hydrate  = useAuthStore(s => s.hydrate);
  const hydrated = useAuthStore(s => s.hydrated);

  useEffect(() => { hydrate(); }, []);

  if (!hydrated) return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
