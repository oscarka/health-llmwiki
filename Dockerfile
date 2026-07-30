# ── Build stage ──────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# 前端构建（生成 dist/）
RUN npm run build || true

# ── Runtime stage ─────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# 只复制运行所需文件
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY server.cjs ./
COPY scripts/ ./scripts/
COPY data/ ./data/

# Cloud Run 强制使用 PORT 环境变量
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.cjs"]
