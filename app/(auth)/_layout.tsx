import { Stack } from 'expo-router';
import { useAuthStore } from '../../store/auth';
import { Redirect } from 'expo-router';

export default function AuthLayout() {
  const agent = useAuthStore(s => s.agent);
  if (agent) return <Redirect href="/(app)/" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
