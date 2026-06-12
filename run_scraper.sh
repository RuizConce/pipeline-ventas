#!/usr/bin/env bash
# run_scraper.sh — ejecuta todas las búsquedas de Google Maps
# Uso: bash run_scraper.sh
set -e

CLIENTE="Conecta CSur"
PRODUCTO="WEB"
MAX=15
SCRAPER="python3 scraper/google_maps.py"

echo "=== Pipeline de Ventas — Scraping Google Maps ==="
echo "Cliente: $CLIENTE | Producto: $PRODUCTO | Max: $MAX por búsqueda"
echo ""

run() {
  local rubro="$1" ciudad="$2"
  echo "▶ $rubro en $ciudad"
  $SCRAPER --rubro "$rubro" --ciudad "$ciudad" --max $MAX --producto "$PRODUCTO" --cliente "$CLIENTE"
  echo ""
}

# Juntas vecinales
run "junta vecinal" "Santiago"
run "junta vecinal" "Valparaíso"
run "junta vecinal" "Concepción"
run "junta vecinal" "Antofagasta"
run "junta vecinal" "Temuco"

# Clubes deportivos
run "club deportivo" "Santiago"
run "club deportivo" "Concepción"

# Organizaciones
run "fundacion" "Santiago"
run "organizacion social" "Santiago"
run "centro cultural" "Santiago"

echo "=== Scraping completado ==="
