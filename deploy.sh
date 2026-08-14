#!/usr/bin/env bash
# deploy.sh — LLMWiki 一键部署到 Cloud Run
# 用法: ./deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT="gen-lang-client-0884226164"
SERVICE="llmwiki"
REGION="asia-northeast1"

echo ""
echo "═══════════════════════════════════════════"
echo "  LLMWiki → Cloud Run 部署"
echo "  服务: ${SERVICE}"
echo "  区域: ${REGION}"
echo "═══════════════════════════════════════════"
echo ""

# 1. 确认 gcloud 已登录
if ! gcloud auth print-identity-token &>/dev/null; then
  echo "❌ gcloud 未登录，请先运行: gcloud auth login"
  exit 1
fi

# 2. 本地构建前端（可选，Dockerfile 里也会 build；若想用最新改动先本地 build）
echo "▶ 本地构建前端（npm run build）..."
npm run build
echo "✓ 前端构建完成"

# 3. 读取 .env 中的关键环境变量
echo ""
echo "▶ 读取 .env 环境变量..."
if [ -f .env ]; then
  ARK_API_KEY=$(grep '^ARK_API_KEY=' .env | cut -d'=' -f2- || true)
  ARK_MODEL=$(grep '^ARK_MODEL=' .env | cut -d'=' -f2- || true)
  ARK_BASE_URL=$(grep '^ARK_BASE_URL=' .env | cut -d'=' -f2- || true)
  GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d'=' -f2- || true)
  SYNC_MODEL=$(grep '^SYNC_MODEL=' .env | cut -d'=' -f2- || true)
  echo "✓ ARK_API_KEY=${ARK_API_KEY:0:10}..."
  echo "✓ ARK_MODEL=${ARK_MODEL}"
  if [ -n "$GEMINI_API_KEY" ]; then
    echo "✓ GEMINI_API_KEY=${GEMINI_API_KEY:0:10}... (Sync 将使用 Gemini)"
    echo "✓ SYNC_MODEL=${SYNC_MODEL:-deepseek-v4-flash-ga-260731}"
  fi
else
  echo "⚠ 未找到 .env 文件，将不设置环境变量"
fi

# 4. 部署到 Cloud Run
echo ""
echo "▶ 部署到 Cloud Run..."

# 动态构造 env vars（避免传入空的 GEMINI_API_KEY 导致格式问题）
ENV_VARS="NODE_ENV=production"
ENV_VARS="${ENV_VARS},ARK_API_KEY=${ARK_API_KEY:-}"
ENV_VARS="${ENV_VARS},ARK_MODEL=${ARK_MODEL:-deepseek-v4-flash-ga-260731}"
ENV_VARS="${ENV_VARS},ARK_BASE_URL=${ARK_BASE_URL:-https://ark.cn-beijing.volces.com/api/v3}"
ENV_VARS="${ENV_VARS},SYNC_MODEL=${SYNC_MODEL:-deepseek-v4-flash-ga-260731}"
if [ -n "${GEMINI_API_KEY:-}" ]; then
  ENV_VARS="${ENV_VARS},GEMINI_API_KEY=${GEMINI_API_KEY}"
fi

gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=1 \
  --timeout=900 \
  --set-env-vars="${ENV_VARS}" \
  --set-secrets="DATABASE_URL=skill-platform-db-url:latest" \
  --quiet

echo ""
echo "✅ 部署成功！"
echo ""

# 4. 获取服务 URL
URL=$(gcloud run services describe "${SERVICE}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --format="value(status.url)" 2>/dev/null)

echo "🌐 访问地址: ${URL}"
echo ""

# 5. 健康检查
echo "▶ 健康检查..."
HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 "${URL}/api/clients" 2>/dev/null || echo "000")
if [ "$HTTP" = "200" ]; then
  echo "✓ API 正常 (HTTP 200)"
else
  echo "⚠ API 返回 HTTP ${HTTP}（可能正在冷启动，稍等再试）"
fi

FRONTEND=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 "${URL}" 2>/dev/null || echo "000")
if [ "$FRONTEND" = "200" ]; then
  echo "✓ 前端正常 (HTTP 200)"
else
  echo "⚠ 前端返回 HTTP ${FRONTEND}"
fi

echo ""
echo "═══════════════════════════════════════════"
