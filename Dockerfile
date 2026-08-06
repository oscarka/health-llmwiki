# ── Build stage（前端）────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app

# 安装前端依赖（需要 devDeps 来 build）
COPY package*.json ./
RUN npm ci

# 复制前端源码并构建
COPY index.html ./
COPY vite.config.js ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# ── Runtime stage（后端 + 前端 dist）────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# 只安装生产依赖
COPY package*.json ./
RUN npm ci --omit=dev

# 复制后端所需文件
COPY server.cjs ./
COPY scripts/ ./scripts/
COPY data/ ./data/

# 从 build stage 复制前端产物
COPY --from=frontend-builder /app/dist ./dist

# Cloud Run 用 PORT 环境变量
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.cjs"]
