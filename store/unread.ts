import { create } from 'zustand';

interface UnreadState {
  total: number;
  setTotal: (n: number) => void;
}

/**
 * Total de mensajes sin leer entre todas las conversaciones.
 * Se actualiza desde la pantalla de Chats y se lee en la tab bar
 * para mostrar el badge, igual que hace Callbell.
 */
export const useUnreadStore = create<UnreadState>((set) => ({
  total: 0,
  setTotal: (n) => set({ total: n }),
}));
