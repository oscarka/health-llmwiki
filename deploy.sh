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

# 3. 线上环境变量（ARK_*/SYNC_MODEL/VISION_MODEL）保持不动：本脚本不再读取/打印本地 .env，避免密钥泄露到终端日志。

# 4. 部署到 Cloud Run
echo ""
echo "▶ 部署到 Cloud Run..."

# 环境变量策略：不再用 --set-env-vars（会整体覆盖线上变量，曾导致 VISION_MODEL 丢失）。
# 线上已有变量(ARK_*/SYNC_MODEL/VISION_MODEL 等)保持不动，只增量设置 NODE_ENV。
# 要改某个变量请单独执行: gcloud run services update llmwiki --update-env-vars KEY=VAL
# 部署后可用 GET /api/_meta 核对线上实际配置。

gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=1 \
  --timeout=900 \
  --update-env-vars="NODE_ENV=production" \
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
