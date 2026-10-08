# ---------- 1) compila o serviço whatsmeow (Go puro, sem CGO) ----------
FROM golang:1-bookworm AS wm
WORKDIR /src
COPY whatsmeow-sidecar/ ./
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto
RUN go get go.mau.fi/whatsmeow@latest modernc.org/sqlite@latest github.com/jackc/pgx/v5@latest google.golang.org/protobuf@latest \
 && go mod tidy \
 && go build -trimpath -ldflags="-s -w" -o /out/wm-sidecar .

# ---------- 2) imagem final: Node + binário ----------
FROM node:22-slim
ENV NODE_ENV=production
# git: o package.json tem dependência vinda do GitHub (sem git o npm falha com "spawn git ENOENT")
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
COPY --from=wm /out/wm-sidecar /usr/local/bin/wm-sidecar
CMD ["node", "index.js"]
