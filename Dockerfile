# ── Build stage ──────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# 只安装生产依赖
COPY package*.json ./
RUN npm ci --omit=dev

# 复制后端所需文件
COPY server.cjs ./
COPY scripts/ ./scripts/
COPY data/ ./data/

# Cloud Run 用 PORT 环境变量
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.cjs"]
