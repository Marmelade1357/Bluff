#!/bin/bash
# Deploy-Skript für "Bluff" auf dem Raspberry Pi (duckpi).
# Holt den neuesten Stand von GitHub und baut/startet die Docker-Container neu.
#
# Einmalig ausführbar machen:
#   chmod +x deploy.sh
#
# Aufruf (im Projektordner, z.B. ~/bluff):
#   ./deploy.sh

set -e  # bei jedem Fehler sofort abbrechen

echo "==> Hole neuesten Stand von GitHub ..."
git pull

echo "==> Baue und starte Container neu ..."
docker compose up -d --build

echo "==> Fertig. Aktueller Status:"
docker compose ps

echo ""
echo "Logs ansehen mit: docker compose logs -f   (Beenden mit Strg+C)"
