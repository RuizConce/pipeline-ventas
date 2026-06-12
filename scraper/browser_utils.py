"""
Utilidades compartidas para lanzar Playwright en distintos entornos.
En Railway (con playwright install --with-deps), Playwright gestiona su propio
Chromium y no se necesita ejecutable explícito. En otros entornos (dev local,
sandbox) se busca el binario manualmente.
"""

import os
import shutil


# Paths conocidos de entornos de desarrollo/sandbox (no Railway)
_DEV_CANDIDATES = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium-1148/chrome-linux/chrome",
]

# Args comunes para todos los entornos
_BASE_ARGS = [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
]


def get_launch_kwargs(headless: bool = True) -> dict:
    """
    Devuelve kwargs para playwright.chromium.launch() adaptados al entorno actual.
    En Railway (RAILWAY_ENVIRONMENT definido), confía en el Chromium instalado
    por Playwright y no pasa executable_path.
    """
    args = list(_BASE_ARGS)

    # En entornos con proxy TLS (sandbox) se necesita ignorar cert errors
    if not os.getenv("RAILWAY_ENVIRONMENT"):
        args.append("--ignore-certificate-errors")

    kwargs: dict = {"headless": headless, "args": args}

    # Fuera de Railway: buscar ejecutable manualmente
    if not os.getenv("RAILWAY_ENVIRONMENT"):
        candidates = _DEV_CANDIDATES + [
            shutil.which("chromium") or "",
            shutil.which("chromium-browser") or "",
            shutil.which("google-chrome") or "",
        ]
        exe = next((p for p in candidates if p and os.path.isfile(p)), None)
        if exe:
            kwargs["executable_path"] = exe

    return kwargs
