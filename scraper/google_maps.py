#!/usr/bin/env python3
import sys
print("INICIANDO SCRIPT", flush=True)
sys.stdout.flush()

"""
Google Maps scraper para extraer leads de negocios locales.
Usa Playwright para automatizar la búsqueda en Google Maps.
"""

import asyncio
import json
import os
import re
import subprocess
import sys
import glob
import mysql.connector
from datetime import datetime
from playwright.async_api import async_playwright
from scraper.browser_utils import get_launch_kwargs
from dotenv import load_dotenv

load_dotenv()


def print_diagnostics():
    """Imprime info de entorno útil para depurar en Railway/Docker."""
    print("=" * 55)
    print(f"[DIAG] Python:        {sys.version.split()[0]}")
    print(f"[DIAG] RAILWAY_ENV:   {os.getenv('RAILWAY_ENVIRONMENT', '(no definido)')}")
    print(f"[DIAG] PW_BROWSERS:   {os.getenv('PLAYWRIGHT_BROWSERS_PATH', '(no definido)')}")

    # Chromium que usará get_launch_kwargs
    kw = get_launch_kwargs()
    exe = kw.get("executable_path", "(playwright default path)")
    print(f"[DIAG] Chromium exe:  {exe}")
    if "executable_path" in kw:
        exists = os.path.isfile(kw["executable_path"])
        print(f"[DIAG] Exe existe:    {exists}")

    # Buscar cualquier chrome/chromium instalado en el sistema
    candidates = glob.glob("/ms-playwright/**/chrome", recursive=True) + \
                 glob.glob("/ms-playwright/**/chrome-linux/chrome", recursive=True) + \
                 glob.glob("/root/.cache/ms-playwright/**/chrome", recursive=True)
    if candidates:
        for c in candidates[:3]:
            print(f"[DIAG] Encontrado:    {c}")
    else:
        print("[DIAG] Encontrado:    (ninguno en /ms-playwright ni ~/.cache)")

    # playwright install --dry-run para ver qué instalaría
    try:
        result = subprocess.run(
            ["playwright", "install", "--dry-run", "chromium"],
            capture_output=True, text=True, timeout=15
        )
        output = (result.stdout + result.stderr).strip()
        for line in output.splitlines()[:6]:
            print(f"[DIAG] pw dry-run:    {line}")
    except Exception as e:
        print(f"[DIAG] pw dry-run:    error — {e}")

    print("=" * 55)

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 3306)),
    "database": os.getenv("DB_NAME", "pipeline_ventas"),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
}


def get_db_connection():
    return mysql.connector.connect(**DB_CONFIG)


def save_lead(lead: dict) -> bool:
    """Guarda un lead en la base de datos, evitando duplicados por email o teléfono."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Verificar duplicado
        cursor.execute(
            "SELECT id FROM leads WHERE email = %s OR (telefono = %s AND telefono != '')",
            (lead.get("email", ""), lead.get("telefono", ""))
        )
        if cursor.fetchone():
            return False

        cursor.execute(
            """INSERT INTO leads (nombre, empresa, rubro, telefono, email, ciudad,
               direccion, website, rating, total_reviews, fuente, cliente, producto)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'google_maps', %s, %s)""",
            (
                lead.get("nombre", ""),
                lead.get("empresa", ""),
                lead.get("rubro", ""),
                lead.get("telefono", ""),
                lead.get("email", ""),
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
        print(f"Error guardando lead: {e}")
        conn.rollback()
        return False
    finally:
        cursor.close()
        conn.close()


async def scrape_google_maps(query: str, ciudad: str, max_results: int = 50, cliente: str = "Conecta CSur", producto: str = ""):
    """Extrae negocios de Google Maps para la búsqueda dada."""
    leads = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(**get_launch_kwargs())
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        )
        page = await context.new_page()

        search_url = f"https://www.google.com/maps/search/{query}+{ciudad}"
        print(f"Buscando: {query} en {ciudad}")
        await page.goto(search_url, wait_until="networkidle")
        await page.wait_for_timeout(3000)

        # Scroll para cargar más resultados
        results_panel = page.locator('div[role="feed"]')
        for _ in range(10):
            await results_panel.evaluate("el => el.scrollTop += 1000")
            await page.wait_for_timeout(1500)
            items = await page.locator('div[role="feed"] > div > div[jsaction]').count()
            if items >= max_results:
                break

        # Extraer cada resultado
        items = await page.locator('div[role="feed"] > div > div[jsaction]').all()
        print(f"Encontrados {len(items)} resultados")

        for i, item in enumerate(items[:max_results]):
            try:
                await item.click()
                await page.wait_for_timeout(2000)

                lead = {"ciudad": ciudad, "rubro": query, "cliente": cliente, "producto": producto}

                # Nombre del negocio
                name_el = page.locator('h1.DUwDvf, h1[class*="fontHeadlineLarge"]').first
                lead["nombre"] = await name_el.inner_text() if await name_el.count() else ""
                lead["empresa"] = lead["nombre"]

                # Dirección
                addr_el = page.locator('button[data-item-id="address"]').first
                lead["direccion"] = await addr_el.inner_text() if await addr_el.count() else ""

                # Teléfono
                phone_el = page.locator('button[data-item-id^="phone"]').first
                phone_text = await phone_el.inner_text() if await phone_el.count() else ""
                lead["telefono"] = re.sub(r"[^\d+\s\-()]", "", phone_text).strip()

                # Website
                web_el = page.locator('a[data-item-id="authority"]').first
                lead["website"] = await web_el.get_attribute("href") if await web_el.count() else ""

                # Rating
                rating_el = page.locator('div.F7nice span[aria-hidden="true"]').first
                try:
                    rating_text = await rating_el.inner_text() if await rating_el.count() else "0"
                    lead["rating"] = float(rating_text.replace(",", "."))
                except (ValueError, TypeError):
                    lead["rating"] = None

                # Reviews
                reviews_el = page.locator('div.F7nice span[aria-label*="reseña"]').first
                try:
                    reviews_text = await reviews_el.inner_text() if await reviews_el.count() else "0"
                    lead["total_reviews"] = int(re.sub(r"[^\d]", "", reviews_text) or 0)
                except (ValueError, TypeError):
                    lead["total_reviews"] = 0

                lead["email"] = ""  # Email requiere visitar el website

                if lead.get("nombre"):
                    saved = save_lead(lead)
                    action = "GUARDADO" if saved else "DUPLICADO"
                    print(f"[{i+1}] {action}: {lead['nombre']} | {lead.get('telefono','')} | {lead.get('rating','')}")
                    if saved:
                        leads.append(lead)

            except Exception as e:
                print(f"Error procesando resultado {i+1}: {e}")
                continue

        await browser.close()

    return leads


async def main():
    import argparse
    print_diagnostics()
    parser = argparse.ArgumentParser(description="Scraper Google Maps para pipeline de ventas")
    parser.add_argument("--rubro", type=str, help="Rubro a buscar (ej: 'restaurantes')")
    parser.add_argument("--ciudad", type=str, default="Temuco", help="Ciudad a buscar")
    parser.add_argument("--cliente", type=str, default="Conecta CSur", help="Cliente al que pertenecen los leads")
    parser.add_argument("--producto", type=str, default="", help="Producto ofrecido (ej: WEB, CRM, SEO)")
    parser.add_argument("--max", type=int, default=30, help="Máximo de resultados por búsqueda")
    args = parser.parse_args()

    if args.rubro:
        leads = await scrape_google_maps(args.rubro, args.ciudad, args.max, args.cliente, args.producto)
        print(f"\n→ {len(leads)} nuevos leads guardados para '{args.rubro}' en {args.ciudad} (cliente: {args.cliente}, producto: {args.producto})")
        return

    # Sin argumentos: ejecutar búsquedas por defecto
    busquedas = [
        ("restaurantes", "Temuco"),
        ("ferreterías", "Temuco"),
        ("talleres mecánicos", "Temuco"),
        ("clínicas dentales", "Temuco"),
        ("gimnasios", "Temuco"),
    ]

    total = 0
    for rubro, ciudad in busquedas:
        leads = await scrape_google_maps(rubro, ciudad, max_results=args.max, cliente=args.cliente, producto=args.producto)
        total += len(leads)
        print(f"→ {len(leads)} nuevos leads guardados para '{rubro}' en {ciudad}\n")

    print(f"\nTotal leads nuevos: {total}")


if __name__ == "__main__":
    asyncio.run(main())
