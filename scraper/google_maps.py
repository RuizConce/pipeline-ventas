#!/usr/bin/env python3
import sys
print("INICIANDO SCRIPT", flush=True)
sys.stdout.flush()

"""
Scraper de negocios locales via Google Places API (Text Search).
Sin Playwright ni Chromium — usa solo requests. Muy liviano en RAM.

Requiere GOOGLE_API_KEY en .env (gratis: $200 crédito/mes en Google Cloud,
~5 000 búsquedas de texto). Activar en:
https://console.cloud.google.com/ → APIs → Places API (New)

Uso:
    python3 scraper/google_maps.py --rubro "restaurantes" --ciudad "Santiago" \
        --max 15 --producto "WEB" --cliente "Conecta CSur"
"""

import os
import requests
import mysql.connector
from dotenv import load_dotenv

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
PLACES_URL = "https://places.googleapis.com/v1/places:searchText"
FIELDS = ",".join([
    "places.displayName",
    "places.formattedAddress",
    "places.nationalPhoneNumber",
    "places.websiteUri",
    "places.rating",
    "places.userRatingCount",
    "places.businessStatus",
])

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 3306)),
    "database": os.getenv("DB_NAME", "pipeline_ventas"),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
}


def print_diagnostics():
    print("=" * 55, flush=True)
    print(f"[DIAG] Python:         {sys.version.split()[0]}", flush=True)
    print(f"[DIAG] Modo:           requests + Google Places API (sin Chromium)", flush=True)
    print(f"[DIAG] RAILWAY_ENV:    {os.getenv('RAILWAY_ENVIRONMENT', '(no definido)')}", flush=True)
    key_status = f"configurada ({GOOGLE_API_KEY[:8]}...)" if GOOGLE_API_KEY else "NO CONFIGURADA ⚠"
    print(f"[DIAG] GOOGLE_API_KEY: {key_status}", flush=True)
    print(f"[DIAG] DB_HOST:        {os.getenv('DB_HOST', '(no definido)')}", flush=True)
    print("=" * 55, flush=True)


def get_db_connection():
    return mysql.connector.connect(**DB_CONFIG)


def save_lead(lead: dict) -> bool:
    """Guarda lead en DB evitando duplicados por teléfono o nombre+ciudad."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """SELECT id FROM leads WHERE
               (telefono != '' AND telefono = %s)
               OR (nombre = %s AND ciudad = %s AND fuente = 'google_maps')""",
            (lead.get("telefono", ""), lead.get("nombre", ""), lead.get("ciudad", ""))
        )
        if cursor.fetchone():
            return False

        cursor.execute(
            """INSERT INTO leads
               (nombre, empresa, rubro, telefono, email, ciudad, direccion,
                website, rating, total_reviews, fuente, cliente, producto)
               VALUES (%s, %s, %s, %s, '', %s, %s, %s, %s, %s, 'google_maps', %s, %s)""",
            (
                lead["nombre"],
                lead["nombre"],
                lead.get("rubro", ""),
                lead.get("telefono", ""),
                lead.get("ciudad", ""),
                lead.get("direccion", ""),
                lead.get("website", ""),
                lead.get("rating"),
                lead.get("total_reviews", 0),
                lead.get("cliente", "Conecta CSur"),
                lead.get("producto", ""),
            )
        )
        conn.commit()
        return True
    except Exception as e:
        print(f"  Error guardando lead: {e}", flush=True)
        conn.rollback()
        return False
    finally:
        cursor.close()
        conn.close()


def search_places(query: str, ciudad: str, max_results: int = 15) -> list:
    """Llama a la Places API (Text Search) y devuelve lista de lugares."""
    if not GOOGLE_API_KEY:
        print("ERROR: GOOGLE_API_KEY no configurado.", flush=True)
        print("  → Activa Places API en https://console.cloud.google.com/", flush=True)
        print("  → Agrega GOOGLE_API_KEY al servicio en Railway Variables.", flush=True)
        return []

    leads = []
    next_page_token = None

    while len(leads) < max_results:
        payload = {
            "textQuery": f"{query} en {ciudad}",
            "languageCode": "es",
            "maxResultCount": min(20, max_results - len(leads)),
        }
        if next_page_token:
            payload["pageToken"] = next_page_token

        try:
            resp = requests.post(
                PLACES_URL,
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": GOOGLE_API_KEY,
                    "X-Goog-FieldMask": FIELDS,
                },
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
        except requests.exceptions.HTTPError as e:
            print(f"  API HTTP error {resp.status_code}: {resp.text[:200]}", flush=True)
            break
        except requests.exceptions.RequestException as e:
            print(f"  API error: {e}", flush=True)
            break

        places = data.get("places", [])
        if not places:
            break

        for place in places:
            if place.get("businessStatus") == "CLOSED_PERMANENTLY":
                continue
            leads.append({
                "nombre":       place.get("displayName", {}).get("text", ""),
                "rubro":        query,
                "ciudad":       ciudad,
                "direccion":    place.get("formattedAddress", ""),
                "telefono":     place.get("nationalPhoneNumber", ""),
                "website":      place.get("websiteUri", ""),
                "rating":       place.get("rating"),
                "total_reviews": place.get("userRatingCount", 0),
            })

        next_page_token = data.get("nextPageToken")
        if not next_page_token or len(leads) >= max_results:
            break

    return leads[:max_results]


def scrape_google_maps(rubro: str, ciudad: str, max_results: int = 15,
                        cliente: str = "Conecta CSur", producto: str = "") -> list:
    """Busca negocios con Places API y los guarda en la DB."""
    print(f"Buscando: '{rubro}' en {ciudad} (max {max_results})", flush=True)
    places = search_places(rubro, ciudad, max_results)
    print(f"Resultados API: {len(places)}", flush=True)

    saved = []
    for i, place in enumerate(places, 1):
        place["cliente"] = cliente
        place["producto"] = producto
        ok = save_lead(place)
        tag = "GUARDADO" if ok else "DUPLICADO"
        rating = f"⭐ {place['rating']}" if place.get("rating") else ""
        print(f"[{i}] {tag}: {place['nombre']} | {place.get('telefono','')} | {rating}", flush=True)
        if ok:
            saved.append(place)

    return saved


def main():
    import argparse
    print_diagnostics()

    parser = argparse.ArgumentParser(description="Scraper Google Maps via Places API")
    parser.add_argument("--rubro",   type=str, help="Rubro a buscar")
    parser.add_argument("--ciudad",  type=str, default="Temuco")
    parser.add_argument("--cliente", type=str, default="Conecta CSur")
    parser.add_argument("--producto", type=str, default="")
    parser.add_argument("--max",     type=int, default=15)
    args = parser.parse_args()

    if args.rubro:
        leads = scrape_google_maps(args.rubro, args.ciudad, args.max, args.cliente, args.producto)
        print(f"\n→ {len(leads)} nuevos leads guardados para '{args.rubro}' en {args.ciudad}", flush=True)
        return

    # Sin argumentos: búsquedas por defecto
    busquedas = [
        ("restaurantes", "Temuco"), ("ferreterías", "Temuco"),
        ("talleres mecánicos", "Temuco"), ("clínicas dentales", "Temuco"),
        ("gimnasios", "Temuco"),
    ]
    total = 0
    for rubro, ciudad in busquedas:
        leads = scrape_google_maps(rubro, ciudad, args.max, args.cliente, args.producto)
        total += len(leads)
        print(f"→ {len(leads)} leads guardados para '{rubro}' en {ciudad}\n", flush=True)
    print(f"\nTotal: {total}", flush=True)


if __name__ == "__main__":
    main()
