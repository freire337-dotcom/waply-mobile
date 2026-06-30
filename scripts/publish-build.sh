#!/usr/bin/env bash
# Genera un build con EAS y publica su enlace en https://waply-backend-production.up.railway.app/download
#
# Uso:
#   export SUPER_ADMIN_TOKEN=...   (el mismo que usa /api/triggers/tenant-key)
#   ./scripts/publish-build.sh [preview|production]
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-preview}"
BACKEND_URL="https://waply-backend-production.up.railway.app"

if [ -z "${SUPER_ADMIN_TOKEN:-}" ]; then
  echo "❌ Falta SUPER_ADMIN_TOKEN. Ejecuta: export SUPER_ADMIN_TOKEN=el_valor_de_railway"
  exit 1
fi

echo "🚀 Generando build Android (perfil: $PROFILE)..."
OUTPUT=$(eas build --platform android --profile "$PROFILE" --non-interactive --json)

URL=$(echo "$OUTPUT" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const b = Array.isArray(d) ? d[0] : d;
  const a = b.artifacts || {};
  // applicationArchiveUrl es el enlace directo al .apk; buildUrl a veces es
  // solo la página del build en expo.dev (no descarga el archivo).
  console.log(a.applicationArchiveUrl || a.buildUrl || '');
")
VERSION=$(node -e "console.log(require('./app.json').expo.version)")

if [ -z "$URL" ]; then
  echo "❌ El build no devolvió una URL de artefacto (¿falló o quedó en cola?)."
  exit 1
fi

echo "✅ Build listo: $URL"
echo "📡 Publicando en $BACKEND_URL/download ..."

curl -sf -X POST "$BACKEND_URL/api/releases" \
  -H "Content-Type: application/json" \
  -H "x-super-token: $SUPER_ADMIN_TOKEN" \
  -d "{\"platform\":\"android\",\"profile\":\"$PROFILE\",\"version\":\"$VERSION\",\"url\":\"$URL\"}" \
  > /dev/null

echo ""
echo "🔗 Listo. Página de descarga (siempre el último build): $BACKEND_URL/download"
