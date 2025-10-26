FROM node:20-slim

# Install Chromium and runtime libs
RUN apt-get update && apt-get install -y       chromium       chromium-sandbox       ca-certificates       fonts-liberation       libasound2       libatk-bridge2.0-0       libatk1.0-0       libcups2       libdbus-1-3       libdrm2       libgbm1       libgtk-3-0       libnspr4       libnss3       libx11-xcb1       libxcomposite1       libxdamage1       libxrandr2       xdg-utils       wget       && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
CMD ["npm", "start"]
