import { Redirect } from 'expo-router';
import { useAuthStore } from '../store/auth';

export default function Index() {
  const agent = useAuthStore(s => s.agent);
  return <Redirect href={agent ? '/(app)/' : '/(auth)/login'} />;
}
