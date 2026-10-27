# compose 的 command 和 `docker compose run --entrypoint cert-renew` 都把 cert-renew 写在命令里，
# 所以这里不设 ENTRYPOINT，只把 cert-renew 放到 PATH。
FROM node:24.22.1-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && find dist -name '*.test.js' -delete

FROM node:24.22.1-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates util-linux \
  && python3 -m venv /opt/certbot \
  && /opt/certbot/bin/pip install --no-cache-dir certbot \
  && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/certbot/bin:${PATH}" \
    CERT_RENEW_DATA_DIR=/var/lib/acme \
    NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN chmod +x /app/dist/cli.js && ln -sf /app/dist/cli.js /usr/local/bin/cert-renew
CMD ["cert-renew", "schedule"]
