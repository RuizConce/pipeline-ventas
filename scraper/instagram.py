#!/usr/bin/env python3
"""
Instagram scraper para extraer leads de negocios locales en Iquique.
Usa Playwright para simular navegación real y evitar bloqueos de IG.

Uso:
    python3 scraper/instagram.py --hashtag "iquiquerestaurante" --max 40 --cliente "Conecta CSur" --producto "WEB"
    python3 scraper/instagram.py --ciudad "Iquique" --cliente "Conecta CSur" --producto "WEB"
"""

import asyncio
import os
import re
import sys
import shutil
import mysql.connector
from dotenv import load_dotenv

load_dotenv()

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 3306)),
    "database": os.getenv("DB_NAME", "pipeline_ventas"),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
}

# Hashtags por ciudad para búsqueda automática
HASHTAGS_POR_CIUDAD = {
    "Iquique": [
        "iquique",
        "iquiquerestaurante",
        "negocioiquique",
        "iquiquecity",
        "iquiqueemprendimiento",
        "emprendedoriquique",
        "iquiquefood",
        "iquiquetienda",
        "iquiqueservicio",
        "iquiquepeluqueria",
    ],
    "Temuco": [
        "temuco",
        "negociotemuco",
        "emprendedortemuco",
        "temucorestaurante",
        "temucofood",
    ],
}

# Patrones para extraer email y teléfono de la bio
RE_EMAIL = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
RE_PHONE = re.compile(r"(?:\+?56\s?)?(?:9\s?\d{4}\s?\d{4}|\d{2,3}[\s\-]\d{3,4}[\s\-]\d{3,4})")
RE_WEB = re.compile(r"https?://[^\s]+|www\.[^\s]+")


def get_db_connection():
    return mysql.connector.connect(**DB_CONFIG)


def es_negocio(perfil: dict) -> bool:
    """Filtra perfiles que parezcan negocios reales."""
    if perfil.get("email"):
        return True
    if perfil.get("website"):
        return True
    if (perfil.get("seguidores") or 0) >= 200:
        return True
    bio = (perfil.get("bio") or "").lower()
    palabras_clave = [
        "restaurante", "tienda", "servicio", "venta", "delivery", "pedido",
        "local", "reserva", "contacto", "whatsapp", "cel", "teléfono",
        "emprendimiento", "negocio", "empresa", "store", "shop",
    ]
    return any(w in bio for w in palabras_clave)


def save_lead(lead: dict) -> bool:
    """Guarda lead en DB evitando duplicados por username de Instagram o email."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Verificar duplicado por email o por nombre (username IG)
        cursor.execute(
            """SELECT id FROM leads WHERE
               (email != '' AND email IS NOT NULL AND email = %s)
               OR (nombre = %s AND fuente = 'instagram')""",
            (lead.get("email", "") or "", lead.get("nombre", ""))
        )
        if cursor.fetchone():
            return False

        cursor.execute(
            """INSERT INTO leads
               (nombre, empresa, rubro, telefono, email, ciudad,
                direccion, website, rating, total_reviews, fuente, cliente, producto, notas)
               VALUES (%s, %s, %s, %s, %s, %s, '', %s, NULL, %s, 'instagram', %s, %s, %s)""",
            (
                lead.get("nombre", ""),
                lead.get("empresa", "") or lead.get("nombre", ""),
                lead.get("rubro", "negocio local"),
                lead.get("telefono", ""),
                lead.get("email", ""),
                lead.get("ciudad", ""),
                lead.get("website", ""),
                lead.get("seguidores", 0),
                lead.get("cliente", "Conecta CSur"),
                lead.get("producto", ""),
                lead.get("bio", "")[:500] if lead.get("bio") else "",
            )
        )
        conn.commit()
        return True
    except Exception as e:
        print(f"  Error guardando lead: {e}")
        conn.rollback()
        return False
    finally:
        cursor.close()
        conn.close()


def parse_seguidores(texto: str) -> int:
    """Convierte '12.4K' o '1,234' a entero."""
    texto = texto.strip().upper().replace(",", "").replace(".", "")
    if "K" in texto:
        return int(float(texto.replace("K", "")) * 1000)
    if "M" in texto:
        return int(float(texto.replace("M", "")) * 1_000_000)
    try:
        return int(re.sub(r"[^\d]", "", texto) or 0)
    except (ValueError, TypeError):
        return 0


def get_chromium_exe() -> str | None:
    candidates = [
        "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
        shutil.which("chromium") or "",
        shutil.which("chromium-browser") or "",
        shutil.which("google-chrome") or "",
    ]
    return next((p for p in candidates if p and os.path.isfile(p)), None)


async def scrape_hashtag(page, hashtag: str, ciudad: str, cliente: str, producto: str,
                          max_perfiles: int = 30) -> list[dict]:
    """Extrae perfiles de negocio desde la página de un hashtag de Instagram."""
    leads = []
    url = f"https://www.instagram.com/explore/tags/{hashtag}/"
    print(f"\n  → Hashtag #{hashtag}")

    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(3000)

        # Cerrar diálogo de login si aparece
        for selector in ['button:has-text("Not Now")', 'button:has-text("Ahora no")',
                          '[aria-label="Close"]', 'button:has-text("Cerrar")']:
            try:
                btn = page.locator(selector).first
                if await btn.is_visible(timeout=2000):
                    await btn.click()
                    await page.wait_for_timeout(1000)
                    break
            except Exception:
                pass

        # Recopilar URLs de posts
        post_links = set()
        for _ in range(5):
            anchors = await page.locator('a[href*="/p/"]').all()
            for a in anchors:
                href = await a.get_attribute("href")
                if href and "/p/" in href:
                    post_links.add(href if href.startswith("http") else f"https://www.instagram.com{href}")
            if len(post_links) >= max_perfiles * 2:
                break
            await page.evaluate("window.scrollBy(0, 1200)")
            await page.wait_for_timeout(1500)

        print(f"     {len(post_links)} posts encontrados, procesando perfiles...")

        perfiles_visitados = set()

        for post_url in list(post_links)[:max_perfiles * 3]:
            if len(leads) >= max_perfiles:
                break
            try:
                await page.goto(post_url, wait_until="domcontentloaded", timeout=15000)
                await page.wait_for_timeout(1500)

                # Cerrar login modal si aparece
                for selector in ['button:has-text("Not Now")', 'button:has-text("Ahora no")']:
                    try:
                        btn = page.locator(selector).first
                        if await btn.is_visible(timeout=1000):
                            await btn.click()
                            await page.wait_for_timeout(500)
                    except Exception:
                        pass

                # Extraer username del post
                username = None
                for sel in [
                    'a[href^="/"][href$="/"] span',
                    'header a[href^="/"]',
                    'article header a',
                ]:
                    try:
                        el = page.locator(sel).first
                        if await el.is_visible(timeout=1000):
                            text = (await el.inner_text()).strip().lstrip("@")
                            if text and "/" not in text and len(text) > 1:
                                username = text
                                break
                    except Exception:
                        pass

                if not username or username in perfiles_visitados:
                    continue
                perfiles_visitados.add(username)

                # Visitar perfil
                profile_url = f"https://www.instagram.com/{username}/"
                await page.goto(profile_url, wait_until="domcontentloaded", timeout=15000)
                await page.wait_for_timeout(2000)

                perfil = {"ciudad": ciudad, "cliente": cliente, "producto": producto,
                          "nombre": f"@{username}", "empresa": ""}

                # Nombre completo
                for sel in ['h1', 'h2', 'span._ap3a']:
                    try:
                        el = page.locator(sel).first
                        text = (await el.inner_text(timeout=2000)).strip()
                        if text and text != username and len(text) > 1:
                            perfil["empresa"] = text
                            break
                    except Exception:
                        pass

                # Bio completa
                bio = ""
                for sel in ['div._aa_c', 'div[class*="biography"]', 'span._ap3a._aaco._aacu._aacx._aad7._aade']:
                    try:
                        el = page.locator(sel).first
                        bio = (await el.inner_text(timeout=2000)).strip()
                        if bio:
                            break
                    except Exception:
                        pass
                perfil["bio"] = bio

                # Extraer email, teléfono y web de la bio
                perfil["email"] = m.group(0) if (m := RE_EMAIL.search(bio)) else ""
                perfil["telefono"] = m.group(0) if (m := RE_PHONE.search(bio)) else ""
                perfil["website"] = m.group(0) if (m := RE_WEB.search(bio)) else ""

                # Website del campo externo de IG
                if not perfil["website"]:
                    for sel in ['a[href*="l.instagram.com"]', 'a[class*="x1i10hfl"]']:
                        try:
                            el = page.locator(sel).first
                            href = await el.get_attribute("href", timeout=1500)
                            if href:
                                perfil["website"] = href
                                break
                        except Exception:
                            pass

                # Seguidores
                perfil["seguidores"] = 0
                for sel in ['a[href*="/followers/"] span', 'span[title]', 'li:has-text("seguidores") span']:
                    try:
                        el = page.locator(sel).first
                        text = await el.inner_text(timeout=1500)
                        n = parse_seguidores(text)
                        if n > 0:
                            perfil["seguidores"] = n
                            break
                    except Exception:
                        pass

                perfil["rubro"] = f"instagram:{hashtag}"

                if not es_negocio(perfil):
                    print(f"     SKIP (no parece negocio): {username} | seg={perfil['seguidores']}")
                    continue

                saved = save_lead(perfil)
                tag = "GUARDADO" if saved else "DUPLICADO"
                print(f"     [{tag}] {username} | {perfil.get('email','')} | seg={perfil['seguidores']} | {perfil.get('website','')[:40]}")
                if saved:
                    leads.append(perfil)

            except Exception as e:
                print(f"     Error en post {post_url}: {e}")
                continue

    except Exception as e:
        print(f"  Error scrapeando #{hashtag}: {e}")

    return leads


async def scrape_instagram(hashtags: list[str], ciudad: str, cliente: str,
                            producto: str, max_por_hashtag: int = 30) -> list[dict]:
    """Ejecuta el scraper sobre la lista de hashtags dados."""
    from playwright.async_api import async_playwright

    chromium_exe = get_chromium_exe()
    launch_kwargs = {
        "headless": True,
        "args": [
            "--ignore-certificate-errors",
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
        ],
    }
    if chromium_exe:
        launch_kwargs["executable_path"] = chromium_exe

    all_leads = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(**launch_kwargs)
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 "
                "Mobile/15E148 Safari/604.1"
            ),
            viewport={"width": 390, "height": 844},
            locale="es-CL",
        )
        # Ocultar que es Playwright
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """)
        page = await context.new_page()

        for hashtag in hashtags:
            leads = await scrape_hashtag(page, hashtag, ciudad, cliente, producto, max_por_hashtag)
            all_leads.extend(leads)
            print(f"  → {len(leads)} leads nuevos de #{hashtag}")
            # Pausa entre hashtags para no gatillar rate limit
            await asyncio.sleep(5)

        await browser.close()

    return all_leads


async def main():
    import argparse
    parser = argparse.ArgumentParser(description="Scraper Instagram para pipeline de ventas")
    parser.add_argument("--hashtag", type=str, help="Hashtag específico a scrapear (sin #)")
    parser.add_argument("--ciudad", type=str, default="Iquique",
                        help="Ciudad (usa hashtags predefinidos). Opciones: Iquique, Temuco")
    parser.add_argument("--cliente", type=str, default="Conecta CSur",
                        help="Cliente al que pertenecen los leads")
    parser.add_argument("--producto", type=str, default="",
                        help="Producto ofrecido (ej: WEB, CRM, SEO)")
    parser.add_argument("--max", type=int, default=30,
                        help="Máximo de perfiles por hashtag")
    args = parser.parse_args()

    if args.hashtag:
        hashtags = [args.hashtag.lstrip("#")]
    else:
        hashtags = HASHTAGS_POR_CIUDAD.get(args.ciudad, HASHTAGS_POR_CIUDAD["Iquique"])

    print(f"Scrapeando {len(hashtags)} hashtags para '{args.ciudad}' "
          f"(cliente: {args.cliente}, producto: {args.producto})")
    print(f"Hashtags: {', '.join('#' + h for h in hashtags)}\n")

    leads = await scrape_instagram(hashtags, args.ciudad, args.cliente, args.producto, args.max)

    print(f"\n{'='*50}")
    print(f"Total leads nuevos guardados: {len(leads)}")


if __name__ == "__main__":
    asyncio.run(main())
