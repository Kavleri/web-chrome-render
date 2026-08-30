FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    NOVNC_PORT=6080 \
    VNC_PORT=5900 \
    CHROME_BIN=/usr/bin/google-chrome

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fluxbox \
        gnupg \
        novnc \
        procps \
        python3 \
        websockify \
        wget \
        x11vnc \
        x11-utils \
        xvfb \
    && mkdir -p /etc/apt/keyrings \
    && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg \
    && printf '%s\n' \
        'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY server.js entrypoint.sh ./
RUN useradd --create-home --shell /usr/sbin/nologin browser \
    && chmod 0755 /app/entrypoint.sh \
    && chown -R browser:browser /app

USER browser

EXPOSE 10000

CMD ["/app/entrypoint.sh"]
