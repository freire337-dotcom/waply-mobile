import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/**
 * Pantalla de notificaciones (estilo Callbell).
 * De momento muestra un estado vacío — el historial real de
 * notificaciones (nuevo lead, cita sin confirmar, etc.) requiere
 * que el backend las guarde en una tabla; hoy solo se envían como
 * push y no quedan registradas. Es el siguiente paso natural aquí.
 */
export default function NotificationsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>🔔</Text>
      <Text style={styles.title}>Sin notificaciones</Text>
      <Text style={styles.subtitle}>
        Aquí verás los avisos de nuevos leads, citas sin confirmar y
        menciones cuando ocurran.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  icon: { fontSize: 48, marginBottom: 12 },
  title: { fontSize: 18, fontWeight: '600', color: '#333' },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginTop: 6,
    textAlign: 'center',
    lineHeight: 20,
  },
});
