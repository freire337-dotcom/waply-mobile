import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../services/api';

let socket: Socket | null = null;

// Callbacks en espera de que el socket exista todavía. Cubre la carrera donde la
// pantalla de conversación se monta (useConversationSocket) antes de que useSocket()
// termine su connect() asíncrono (ej. justo al abrir la app) — sin esto el join a la
// sala se saltaba en silencio y esa pantalla nunca recibía mensajes en vivo.
const onSocketReady: Array<() => void> = [];

function setSocket(s: Socket | null) {
  socket = s;
  if (s) {
    onSocketReady.splice(0).forEach(cb => cb());
  }
}

export function getSocket() {
  return socket;
}

export function useSocket(onConversationUpdated?: (conv: any) => void, onReconnect?: () => void) {
  const callbackRef = useRef(onConversationUpdated);
  callbackRef.current = onConversationUpdated;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;

  useEffect(() => {
    let mounted = true;
    let hasConnectedOnce = false;

    const connect = async () => {
      const token = await AsyncStorage.getItem('token');
      if (!token || !mounted) return;

      const s = io(API_BASE, {
        auth: { token },
        transports: ['websocket'],
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
      });

      s.on('connect', () => {
        console.log('🟢 Socket conectado');
        // Mientras el socket estuvo caído (wifi, app en background, deploy del
        // backend) cualquier conversation:updated emitido se perdió — el servidor
        // no los reenvía al reconectar. Sin este resync la lista se quedaba
        // desactualizada hasta que el usuario forzaba un refresh manual.
        if (hasConnectedOnce) reconnectRef.current?.();
        hasConnectedOnce = true;
      });
      s.on('disconnect', (reason) => console.log('🔴 Socket desconectado:', reason));

      s.on('conversation:updated', (conv) => {
        callbackRef.current?.(conv);
      });

      setSocket(s);
    };

    connect();

    return () => {
      mounted = false;
      socket?.disconnect();
      setSocket(null);
    };
  }, []);
}

export function useConversationSocket(
  convId: number,
  onMessage: (msg: any) => void,
  onReconnect?: () => void,
  // Editar/eliminar mensaje puede pasar desde WaplyAdmin web mientras el móvil
  // tiene la misma conversación abierta — sin esto, el chat se quedaría con la
  // versión vieja del mensaje hasta salir y volver a entrar a la pantalla.
  onMessageUpdated?: (msg: any) => void,
  onMessageDeleted?: (info: { id: number; conversation_id: number }) => void
) {
  const callbackRef = useRef(onMessage);
  callbackRef.current = onMessage;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;
  const updatedRef = useRef(onMessageUpdated);
  updatedRef.current = onMessageUpdated;
  const deletedRef = useRef(onMessageDeleted);
  deletedRef.current = onMessageDeleted;

  useEffect(() => {
    if (!convId) return;
    let active = true;
    let attachedSocket: Socket | null = null;
    let hasJoinedOnce = false;
    const handler        = (msg: any) => callbackRef.current(msg);
    const updatedHandler  = (msg: any) => updatedRef.current?.(msg);
    const deletedHandler  = (info: any) => deletedRef.current?.(info);
    const join = () => {
      attachedSocket?.emit('join:conversation', convId);
      // Igual que arriba: los mensajes que llegaron durante el corte no se
      // reenvían solos al volver a unirse a la sala — hay que resincronizar
      // la conversación abierta a mano (recargar mensajes desde la API).
      if (hasJoinedOnce) reconnectRef.current?.();
      hasJoinedOnce = true;
    };

    const attach = (s: Socket) => {
      if (!active || attachedSocket) return;
      attachedSocket = s;
      s.on('message:new', handler);
      s.on('message:updated', updatedHandler);
      s.on('message:deleted', deletedHandler);
      // El servidor olvida la membresía de la sala "conv:{id}" cada vez que el
      // socket se reconecta (ej. el móvil pierde cobertura un instante o cambia
      // de wifi a datos) — sin re-emitir join:conversation en cada 'connect', la
      // conversación abierta deja de recibir mensajes en vivo hasta que el usuario
      // sale y vuelve a entrar a la pantalla. Esto es lo que se percibía como
      // "los mensajes llegan con retardo" incluso con la app en primer plano.
      s.on('connect', join);
      join();
    };

    if (socket) {
      attach(socket);
    } else {
      onSocketReady.push(() => { if (active && socket) attach(socket); });
    }

    return () => {
      active = false;
      if (attachedSocket) {
        attachedSocket.emit('leave:conversation', convId);
        attachedSocket.off('message:new', handler);
        attachedSocket.off('message:updated', updatedHandler);
        attachedSocket.off('message:deleted', deletedHandler);
        attachedSocket.off('connect', join);
      }
    };
  }, [convId]);
}
