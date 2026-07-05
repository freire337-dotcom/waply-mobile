import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../../store/auth';

export default function SettingsScreen() {
  const { agent, logout } = useAuthStore();

  const initials = (agent?.name || agent?.email || '?')
    .split(' ')
    .slice(0, 2)
    .map((w: string) => w[0])
    .join('')
    .toUpperCase();

  const confirmLogout = () => {
    Alert.alert('Cerrar sesión', '¿Seguro que quieres salir?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Cerrar sesión', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <View style={styles.container}>
      {/* Tarjeta de perfil */}
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{agent?.name || 'Agente'}</Text>
        <Text style={styles.email}>{agent?.email}</Text>
        {agent?.role && (
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>
              {agent.role === 'admin' ? 'Administrador' : 'Agente'}
            </Text>
          </View>
        )}
      </View>

      {/* Opciones */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.row} onPress={confirmLogout}>
          <Ionicons name="log-out-outline" size={20} color="#e53e3e" />
          <Text style={styles.rowTextDanger}>Cerrar sesión</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.version}>Waplyy · v1.2.0</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  profileCard: {
    backgroundColor: '#fff',
    alignItems: 'center',
    paddingVertical: 28,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#128C7E',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarText: { color: '#fff', fontSize: 26, fontWeight: '700' },
  name: { fontSize: 18, fontWeight: '700', color: '#111' },
  email: { fontSize: 13, color: '#888', marginTop: 2 },
  roleBadge: {
    marginTop: 10,
    backgroundColor: 'rgba(18,140,126,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  roleText: { color: '#128C7E', fontSize: 12, fontWeight: '700' },

  section: {
    marginTop: 24,
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e5e5',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  rowTextDanger: { color: '#e53e3e', fontSize: 15, fontWeight: '600' },

  version: {
    textAlign: 'center',
    color: '#aaa',
    fontSize: 12,
    marginTop: 24,
  },
});
