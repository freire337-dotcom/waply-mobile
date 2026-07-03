/**
 * useUpdateChecker
 * Al montar, consulta /api/releases/latest en el backend.
 * Si la versión remota es mayor que la instalada, muestra un Alert
 * con botón de descarga que abre la página /download.
 */
import { useEffect } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import { API_BASE } from '../services/api';

// Versión actual de la app (sincronizar con app.json cada build)
const CURRENT_VERSION = '1.2.0';

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function useUpdateChecker() {
  useEffect(() => {
    // Solo Android (iOS se gestiona por App Store)
    if (Platform.OS !== 'android') return;

    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/releases/latest?platform=android`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const data = await res.json();
        const remoteVersion: string = data.version || '0.0.0';

        if (compareVersions(remoteVersion, CURRENT_VERSION) > 0) {
          Alert.alert(
            '🆕 Nueva versión disponible',
            `Hay una actualización (v${remoteVersion}). ¿Descargar ahora?`,
            [
              { text: 'Ahora no', style: 'cancel' },
              {
                text: 'Descargar',
                onPress: () => Linking.openURL(`${API_BASE}/download`),
              },
            ],
            { cancelable: true }
          );
        }
      } catch {
        // Silencioso — no interrumpir al usuario si falla la comprobación
      }
    };

    // Pequeño delay para no bloquear el arranque
    const t = setTimeout(check, 3000);
    return () => clearTimeout(t);
  }, []);
}
