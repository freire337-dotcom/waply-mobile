import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { login as apiLogin, getMe } from '../services/api';

export interface Agent {
  id: number;
  name: string;
  email: string;
  role: 'agent' | 'admin';
}

interface AuthState {
  agent: Agent | null;
  token: string | null;
  isLoading: boolean;
  hydrated: boolean;
  login: (email: string, password: string, tenantSlug: string) => Promise<void>;
  logout: () => Promise<void>;
  hydrate: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  agent: null,
  token: null,
  isLoading: false,
  hydrated: false,

  hydrate: async () => {
    const token = await AsyncStorage.getItem('token');
    if (token) {
      try {
        const agent = await getMe();
        set({ agent, token, hydrated: true });
      } catch {
        await AsyncStorage.removeItem('token');
        set({ hydrated: true });
      }
    } else {
      set({ hydrated: true });
    }
  },

  login: async (email, password, tenantSlug) => {
    set({ isLoading: true });
    try {
      const { token, agent } = await apiLogin(email, password, tenantSlug);
      await AsyncStorage.setItem('token', token);
      await AsyncStorage.setItem('tenant_slug', tenantSlug);
      set({ agent, token, isLoading: false });
    } catch (err) {
      set({ isLoading: false });
      throw err;
    }
  },

  logout: async () => {
    await AsyncStorage.removeItem('token');
    set({ agent: null, token: null });
  },
}));
