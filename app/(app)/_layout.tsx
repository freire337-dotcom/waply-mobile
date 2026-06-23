import { Stack } from 'expo-router';
import { Redirect } from 'expo-router';
import { useAuthStore } from '../../store/auth';
import { useNotifications } from '../../hooks/useNotifications';
import { useSocket } from '../../hooks/useSocket';

export default function AppLayout() {
  const agent = useAuthStore(s => s.agent);

  // Inicializar push notifications y WebSocket al entrar a la app
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
