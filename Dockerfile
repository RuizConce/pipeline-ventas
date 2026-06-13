FROM node:18-slim

# ── Sistema base ─────────────────────────────────────────────────────────────
# python3 + pip + dependencias de sistema que necesita Chromium headless
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    # Chromium system deps (lista de playwright install-deps)
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dependencias Python ───────────────────────────────────────────────────────
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Descargar Chromium gestionado por Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN playwright install chromium

# ── Dependencias Node ─────────────────────────────────────────────────────────
COPY package*.json ./
RUN npm install --production

# ── Código fuente ─────────────────────────────────────────────────────────────
COPY . .

EXPOSE 3001

CMD ["node", "crm/server.js"]
