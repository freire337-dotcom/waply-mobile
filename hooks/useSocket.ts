import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../services/api';

let socket: Socket | null = null;

export function getSocket() {
  return socket;
}

export function useSocket(onConversationUpdated?: (conv: any) => void) {
  const callbackRef = useRef(onConversationUpdated);
  callbackRef.current = onConversationUpdated;

  useEffect(() => {
    let mounted = true;

    const connect = async () => {
      const token = await AsyncStorage.getItem('token');
      if (!token || !mounted) return;

      socket = io(API_BASE, {
        auth: { token },
        transports: ['websocket'],
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
      });

      socket.on('connect', () => console.log('🟢 Socket conectado'));
      socket.on('disconnect', (reason) => console.log('🔴 Socket desconectado:', reason));

      socket.on('conversation:updated', (conv) => {
        callbackRef.current?.(conv);
      });
    };

    connect();

    return () => {
      mounted = false;
      socket?.disconnect();
      socket = null;
    };
  }, []);
}

export function useConversationSocket(
  convId: number,
  onMessage: (msg: any) => void
) {
  const callbackRef = useRef(onMessage);
  callbackRef.current = onMessage;

  useEffect(() => {
    if (!socket || !convId) return;

    socket.emit('join:conversation', convId);

    const handler = (msg: any) => callbackRef.current(msg);
    socket.on('message:new', handler);

    return () => {
      socket?.emit('leave:conversation', convId);
      socket?.off('message:new', handler);
    };
  }, [convId]);
}
