FROM node:20-slim

WORKDIR /app

# Wichtig: Browser in einen festen Pfad im Image installieren (nicht in /root/.cache)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm install

# Browser + Linux-Dependencies installieren
RUN npx playwright install --with-deps chromium

# (optional aber gut) sicherstellen dass der Ordner existiert
RUN ls -la /ms-playwright || true

COPY . .

CMD ["node", "server.js"]