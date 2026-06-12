"""
Utilidades compartidas para lanzar Playwright en distintos entornos.

Prioridad de detección:
  1. Docker/Railway: PLAYWRIGHT_BROWSERS_PATH=/ms-playwright (Dockerfile)
  2. Railway Nixpacks: RAILWAY_ENVIRONMENT definido, Playwright usa su path nativo
  3. Dev local / sandbox: busca binario en paths conocidos
"""

import os
import shutil


# Paths conocidos de entornos de desarrollo/sandbox
_DEV_CANDIDATES = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium-1148/chrome-linux/chrome",
]

_BASE_ARGS = [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
]

# En Docker el Chromium queda en /ms-playwright/chromium-*/chrome-linux/chrome
def _find_docker_chromium() -> str | None:
    base = os.getenv("PLAYWRIGHT_BROWSERS_PATH", "")
    if not base or not os.path.isdir(base):
        return None
    import glob
    matches = sorted(glob.glob(f"{base}/chromium-*/chrome-linux/chrome"))
    return matches[-1] if matches else None


def get_launch_kwargs(headless: bool = True) -> dict:
    """Devuelve kwargs para playwright.chromium.launch() según el entorno."""
    args = list(_BASE_ARGS)
    kwargs: dict = {"headless": headless, "args": args}

    # 1. Docker con PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
    docker_exe = _find_docker_chromium()
    if docker_exe:
        kwargs["executable_path"] = docker_exe
        return kwargs

    # 2. Railway Nixpacks (RAILWAY_ENVIRONMENT set) — Playwright gestiona su path
    if os.getenv("RAILWAY_ENVIRONMENT"):
        return kwargs

    # 3. Dev / sandbox — buscar manualmente + ignorar cert errors del proxy TLS
    args.append("--ignore-certificate-errors")
    candidates = _DEV_CANDIDATES + [
        shutil.which("chromium") or "",
        shutil.which("chromium-browser") or "",
        shutil.which("google-chrome") or "",
    ]
    exe = next((p for p in candidates if p and os.path.isfile(p)), None)
    if exe:
        kwargs["executable_path"] = exe

    return kwargs
