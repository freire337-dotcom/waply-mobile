import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { saveFcmToken } from '../services/api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function useNotifications() {
  useEffect(() => {
    registerForPushNotifications();

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const conversationId = response.notification.request.content.data?.conversation_id;
      if (conversationId) {
        router.push(`/(app)/conversation/${conversationId}`);
      }
    });

    return () => sub.remove();
  }, []);
}

async function registerForPushNotifications() {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.warn('Permiso de notificaciones denegado');
    return;
  }

  if (Platform.OS === 'android') {
    // Id de canal nuevo ('waply-alerts', antes 'default') — Android congela el
    // sonido/importancia de un canal la primera vez que se crea y los ignora en
    // actualizaciones posteriores de la app, solo los aplica si el canal es nuevo
    // o tras desinstalar. Debe coincidir con el channelId que envía el backend
    // (services/whatsapp.js) en cada push.
    await Notifications.setNotificationChannelAsync('waply-alerts', {
      name: 'Waply',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#25D366',
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: false,
    });
  }

  try {
    const token = await Notifications.getExpoPushTokenAsync();
    await saveFcmToken(token.data);
    console.log('FCM token registrado:', token.data);
  } catch (err) {
    console.warn('Error registrando FCM token:', err);
  }
}
