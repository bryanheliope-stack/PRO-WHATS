# ---------- 1) compila o serviço auxiliar do whatsmeow (Go, sem navegador) ----------
FROM golang:1-bookworm AS wm
WORKDIR /src
COPY whatsmeow-sidecar/ ./
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto
RUN go get go.mau.fi/whatsmeow@latest modernc.org/sqlite@latest github.com/jackc/pgx/v5@latest google.golang.org/protobuf@latest \
 && go mod tidy \
 && go build -trimpath -ldflags="-s -w" -o /out/wm-sidecar .

# ---------- 2) imagem final: Node + binário do whatsmeow ----------
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production WM_BIN=/usr/local/bin/wm-sidecar
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
COPY --from=wm /out/wm-sidecar /usr/local/bin/wm-sidecar
CMD ["node", "index.js"]
