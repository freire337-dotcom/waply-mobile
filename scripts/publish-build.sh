#!/usr/bin/env bash
# publish-build.sh — Descarga el APK de EAS, lo sube a GitHub Releases
# y registra la URL pública en el backend de Waply.
#
# Variables requeridas:
#   SUPER_ADMIN_TOKEN  — token de Railway
#   GITHUB_TOKEN       — Personal Access Token con scope 'repo'
#
# Uso:
#   ./scripts/publish-build.sh [BUILD_ID]
#   Si omites BUILD_ID usa el último build del proyecto.

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-https://waply-backend-production.up.railway.app}"
GITHUB_REPO="freire337-dotcom/waply-backend"
PROFILE="${PROFILE:-preview}"
PLATFORM="${PLATFORM:-android}"
TMP_APK="/tmp/waply_build.apk"

# ── Validaciones ──────────────────────────────────────────────────────────────
if [[ -z "${SUPER_ADMIN_TOKEN:-}" ]]; then
  echo "❌  Falta SUPER_ADMIN_TOKEN"; exit 1
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "❌  Falta GITHUB_TOKEN (crea uno en https://github.com/settings/tokens con scope 'repo')"; exit 1
fi

# ── Obtener info del build ────────────────────────────────────────────────────
if [[ -n "${1:-}" ]]; then
  BUILD_ID="$1"
  echo "🔍  Consultando build $BUILD_ID..."
  BUILD_JSON=$(eas build:view "$BUILD_ID" --json 2>/dev/null)
else
  echo "🔍  Buscando último build '$PROFILE'..."
  BUILD_JSON=$(eas build:list --platform "$PLATFORM" --profile "$PROFILE" --limit 1 --json 2>/dev/null | python3 -c "import sys,json; arr=json.load(sys.stdin); print(json.dumps(arr[0]) if arr else '{}')")
  BUILD_ID=$(echo "$BUILD_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
fi

VERSION=$(echo "$BUILD_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('appVersion') or json.load(open('/dev/stdin')) or '')" 2>/dev/null || node -p "require('./app.json').expo?.version || '1.0.0'" 2>/dev/null || echo "1.0.0")
VERSION=$(node -p "require('./app.json').expo?.version || '1.0.0'" 2>/dev/null || echo "1.0.0")

echo "📦  Descargando APK del build $BUILD_ID (v$VERSION)..."
eas build:download --id "$BUILD_ID" --output "$TMP_APK" 2>/dev/null || {
  echo "⚠  eas build:download falló, intentando con la URL directa..."
  EAS_URL=$(echo "$BUILD_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('artifacts',{}).get('buildUrl',''))")
  if [[ -z "$EAS_URL" ]]; then echo "❌  No hay URL de APK"; exit 1; fi
  # Descargar usando la sesión de EAS guardada localmente
  EXPO_TOKEN=$(python3 -c "import json,os; s=json.load(open(os.path.expanduser('~/.expo/state.json'))); print(s.get('auth',{}).get('sessionSecret',''))" 2>/dev/null || echo "")
  CURL_AUTH=""
  [[ -n "$EXPO_TOKEN" ]] && CURL_AUTH="-H 'expo-session: $EXPO_TOKEN'"
  eval curl -L -f $CURL_AUTH -o "$TMP_APK" "$EAS_URL" || { echo "❌  No se pudo descargar el APK"; exit 1; }
}

APK_SIZE=$(du -sh "$TMP_APK" | cut -f1)
echo "✅  APK descargado ($APK_SIZE)"

# ── Subir a GitHub Releases ───────────────────────────────────────────────────
TAG="v${VERSION}-$(date +%Y%m%d%H%M)"
echo "🚀  Creando GitHub Release $TAG..."

RELEASE=$(curl -sf -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases" \
  -d "{\"tag_name\":\"${TAG}\",\"name\":\"Waply ${VERSION}\",\"body\":\"Build automático EAS — ${BUILD_ID}\",\"draft\":false,\"prerelease\":false}")

UPLOAD_URL=$(echo "$RELEASE" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['upload_url'].split('{')[0])")

echo "⬆  Subiendo APK a GitHub..."
curl -sf -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/vnd.android.package-archive" \
  "${UPLOAD_URL}?name=waply.apk&label=waply.apk" \
  --data-binary @"$TMP_APK" > /dev/null

DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG}/waply.apk"
echo "✅  APK público: $DOWNLOAD_URL"

# ── Registrar en backend ──────────────────────────────────────────────────────
echo "📡  Registrando en backend..."
HTTP=$(curl -sf -o /tmp/release_resp.txt -w "%{http_code}" \
  -X POST "$BACKEND_URL/api/releases" \
  -H "Content-Type: application/json" \
  -H "x-super-token: $SUPER_ADMIN_TOKEN" \
  -d "{\"platform\":\"$PLATFORM\",\"profile\":\"$PROFILE\",\"version\":\"$VERSION\",\"url\":\"$DOWNLOAD_URL\"}")

if [[ "$HTTP" == "200" ]]; then
  echo ""
  echo "🎉  ¡Listo! Página de descarga actualizada:"
  echo "    $BACKEND_URL/download"
  echo "    URL directa APK: $DOWNLOAD_URL"
else
  echo "❌  Error HTTP $HTTP al registrar en backend:"
  cat /tmp/release_resp.txt
  exit 1
fi

rm -f "$TMP_APK"
