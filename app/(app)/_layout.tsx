import { Stack } from 'expo-router';
import { Redirect } from 'expo-router';
import { useAuthStore } from '../../store/auth';
import { useSocket } from '../../hooks/useSocket';
import { useNotifications } from '../../hooks/useNotifications';

export default function AppLayout() {
  const agent = useAuthStore(s => s.agent);

  useNotifications();
  useSocket();

  if (!agent) return <Redirect href="/(auth)/login" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="conversation/[id]"
        options={{
          headerShown: true,
          headerStyle: { backgroundColor: '#075E54' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '600' },
          headerBackTitle: '',
        }}
      />
    </Stack>
  );
}
