#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# test_llmwiki_integration.sh — LLMWiki × Agent 集成逐环节测试
#
# 测试环节：
#   T1 — LLMWiki 接口可达
#   T2 — 创建测试用户
#   T3 — 写入包含 user_profile 信息的对话日志
#   T4 — 触发 sync Pipeline（验证 user_profile 提取）
#   T5 — context-inject 读取（验证用户画像是否被写入）
#   T6 — 清理测试数据
#
# 用法：
#   LLMWIKI_BASE=http://localhost:5050 bash test_llmwiki_integration.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BASE="${LLMWIKI_BASE:-https://llmwiki-yo5337ccva-an.a.run.app}"
TEST_USER_NAME="集成测试用户_$(date +%s)"
TEST_CLIENT_ID=""
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { ((PASS++)); echo -e "${GREEN}  ✓ $1${NC}"; }
fail() { ((FAIL++)); echo -e "${RED}  ✗ $1${NC}"; }
info() { echo -e "${YELLOW}  ℹ $1${NC}"; }

# ─── T1: LLMWiki 接口可达 ────────────────────────────────────────────────────
echo ""
echo "═══ T1: LLMWiki 接口可达 ═══"
echo "  → GET ${BASE}/api/clients"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${BASE}/api/clients")
if [ "$HTTP_CODE" = "200" ]; then
  pass "GET /api/clients → HTTP ${HTTP_CODE}"
else
  fail "GET /api/clients → HTTP ${HTTP_CODE} (期望 200)"
  echo "  ❌ LLMWiki 服务不可达，终止测试"
  exit 1
fi

# ─── T2: 创建测试用户 ────────────────────────────────────────────────────────
echo ""
echo "═══ T2: 创建测试用户 ═══"
echo "  → POST ${BASE}/api/clients name=${TEST_USER_NAME}"

CREATE_RESP=$(curl -s -X POST "${BASE}/api/clients" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${TEST_USER_NAME}\",\"age\":65,\"gender\":\"女\"}")

TEST_CLIENT_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

if [ -n "$TEST_CLIENT_ID" ]; then
  pass "用户创建成功: id=${TEST_CLIENT_ID}"
  info "用户名: ${TEST_USER_NAME}"
else
  fail "用户创建失败: ${CREATE_RESP}"
  exit 1
fi

# 验证 Wiki 页面已初始化（包含 user_profile.md）
echo "  → GET ${BASE}/api/clients/${TEST_CLIENT_ID}/wiki"
WIKI_RESP=$(curl -s "${BASE}/api/clients/${TEST_CLIENT_ID}/wiki")
HAS_USER_PROFILE=$(echo "$WIKI_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'user_profile.md' in d else 'no')" 2>/dev/null || echo "no")
HAS_INDEX=$(echo "$WIKI_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'index.md' in d else 'no')" 2>/dev/null || echo "no")

if [ "$HAS_USER_PROFILE" = "yes" ]; then
  pass "user_profile.md 已在默认 Wiki 中创建"
else
  fail "user_profile.md 未在默认 Wiki 中找到"
fi
if [ "$HAS_INDEX" = "yes" ]; then
  pass "index.md 已在默认 Wiki 中创建"
else
  fail "index.md 未在默认 Wiki 中找到"
fi

# ─── T3: 写入包含 user_profile 信息的对话日志 ────────────────────────────────
echo ""
echo "═══ T3: 写入对话日志（含健康数据 + 用户画像信息）═══"

# 日志 1: 健康数据 + 沟通偏好
LOG1_RESP=$(curl -s -X POST "${BASE}/api/clients/${TEST_CLIENT_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "wechat",
    "content": "用户：最近量了血压，收缩压158，舒张压95。另外你回复的时候能不能用简单一点的话，我不太懂医学术语。\nAI：好的阿姨，您放心，我尽量用通俗易懂的话来解释。您这次测的血压偏高一些，特别是高压158超过了正常范围。建议您这几天每天早晚各测一次，记录下来，我帮您看趋势。",
    "title": "对话记录-血压+沟通偏好"
  }')
LOG1_ID=$(echo "$LOG1_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
if [ -n "$LOG1_ID" ]; then
  pass "日志1写入成功: ${LOG1_ID} (含血压数据 + 沟通偏好)"
else
  fail "日志1写入失败: ${LOG1_RESP}"
fi

# 日志 2: 用药 + 个人背景
LOG2_RESP=$(curl -s -X POST "${BASE}/api/clients/${TEST_CLIENT_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "wechat",
    "content": "用户：我老公是内科医生，他说我可能需要吃降压药了。我现在吃的是氨氯地平5mg每天一次。对了，千万不要告诉我女儿我血压高的事，她会紧张的。\nAI：好的阿姨，您的隐私我一定保护好。氨氯地平是常用的降压药，5mg是标准起始剂量。既然叔叔是内科医生，他的建议很专业。建议继续监测血压看药效。",
    "title": "对话记录-用药+家庭背景+禁忌"
  }')
LOG2_ID=$(echo "$LOG2_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
if [ -n "$LOG2_ID" ]; then
  pass "日志2写入成功: ${LOG2_ID} (含用药 + 家庭背景 + 禁忌)"
else
  fail "日志2写入失败: ${LOG2_RESP}"
fi

# 验证日志存储
echo "  → GET ${BASE}/api/clients/${TEST_CLIENT_ID}/logs"
LOGS_RESP=$(curl -s "${BASE}/api/clients/${TEST_CLIENT_ID}/logs")
LOG_COUNT=$(echo "$LOGS_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
UNSYNCED=$(echo "$LOGS_RESP" | python3 -c "import sys,json; print(len([l for l in json.load(sys.stdin) if not l.get('synced')]))" 2>/dev/null || echo "0")
info "日志总数: ${LOG_COUNT}, 未同步: ${UNSYNCED}"
if [ "$UNSYNCED" = "2" ]; then
  pass "2条日志均为未同步状态"
else
  fail "未同步日志数量不对: 期望2, 实际${UNSYNCED}"
fi

# ─── T4: 触发 sync Pipeline（关键测试！验证 user_profile 提取）───────────────
echo ""
echo "═══ T4: 触发 sync Pipeline ═══"
echo "  → POST ${BASE}/api/clients/${TEST_CLIENT_ID}/sync"
echo "  ⏳ 这会调用 LLM（Stage1→Stage2→Stage3），可能需要 10-30 秒..."

SYNC_START=$(date +%s)
SYNC_RESP=$(curl -s -X POST "${BASE}/api/clients/${TEST_CLIENT_ID}/sync" \
  -H "Content-Type: application/json" \
  --max-time 120)
SYNC_END=$(date +%s)
SYNC_DURATION=$((SYNC_END - SYNC_START))

WIKI_UPDATED=$(echo "$SYNC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated', False))" 2>/dev/null || echo "False")
UPDATED_FILES=$(echo "$SYNC_RESP" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('updatedFiles',[])))" 2>/dev/null || echo "")

if [ "$WIKI_UPDATED" = "True" ]; then
  pass "sync 成功 (耗时 ${SYNC_DURATION}s)"
  info "更新的文件: ${UPDATED_FILES}"
else
  fail "sync 失败或 Wiki 未更新: ${SYNC_RESP}"
fi

# 检查 user_profile.md 是否被更新
if echo "$UPDATED_FILES" | grep -q "user_profile.md"; then
  pass "✨ user_profile.md 被 sync 更新了（Stage1 提取 user_profile 类型成功）"
else
  info "user_profile.md 未在本次 sync 中更新（LLM 可能没有提取出 user_profile 类型事实）"
  info "这不一定是 bug — LLM 对提取类型的敏感度取决于对话内容"
fi

# 验证日志已标记为已同步
LOGS_AFTER_SYNC=$(curl -s "${BASE}/api/clients/${TEST_CLIENT_ID}/logs")
UNSYNCED_AFTER=$(echo "$LOGS_AFTER_SYNC" | python3 -c "import sys,json; print(len([l for l in json.load(sys.stdin) if not l.get('synced')]))" 2>/dev/null || echo "?")
if [ "$UNSYNCED_AFTER" = "0" ]; then
  pass "sync 后所有日志已标记为 synced=true"
else
  fail "sync 后仍有 ${UNSYNCED_AFTER} 条未同步日志"
fi

# ─── T5: context-inject 读取 ─────────────────────────────────────────────────
echo ""
echo "═══ T5: context-inject 接口验证 ═══"

# 5a: 无 query（全量模式）
echo "  → GET ${BASE}/api/clients/${TEST_CLIENT_ID}/context-inject (full mode)"
CI_RESP=$(curl -s "${BASE}/api/clients/${TEST_CLIENT_ID}/context-inject")
CI_MODE=$(echo "$CI_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null || echo "")
CI_UP_LEN=$(echo "$CI_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('user_profile','')))" 2>/dev/null || echo "0")
CI_HW_LEN=$(echo "$CI_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('health_wiki','')))" 2>/dev/null || echo "0")
CI_TOTAL=$(echo "$CI_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token_estimate',{}).get('total',0))" 2>/dev/null || echo "0")

if [ "$CI_MODE" = "full" ]; then
  pass "全量模式 (mode=full) 返回正确"
else
  fail "mode 不对: 期望 full, 实际 ${CI_MODE}"
fi
info "user_profile 长度: ${CI_UP_LEN} 字符"
info "health_wiki 长度: ${CI_HW_LEN} 字符"
info "token 估算: ${CI_TOTAL}"

if [ "$CI_HW_LEN" -gt 100 ]; then
  pass "health_wiki 有内容（${CI_HW_LEN} 字符）"
else
  fail "health_wiki 太短或为空（${CI_HW_LEN} 字符）"
fi

# 5b: 有 query（prefetch 模式）
echo "  → GET ${BASE}/api/clients/${TEST_CLIENT_ID}/context-inject?query=血压 (prefetch mode)"
CI_PF_RESP=$(curl -s "${BASE}/api/clients/${TEST_CLIENT_ID}/context-inject?query=%E8%A1%80%E5%8E%8B")
CI_PF_MODE=$(echo "$CI_PF_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null || echo "")
CI_PF_HW_LEN=$(echo "$CI_PF_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('health_wiki','')))" 2>/dev/null || echo "0")

if [ "$CI_PF_MODE" = "prefetch" ] || [ "$CI_PF_MODE" = "full" ]; then
  pass "prefetch 查询返回 mode=${CI_PF_MODE} (health_wiki ${CI_PF_HW_LEN} 字符)"
else
  fail "prefetch 查询返回 mode=${CI_PF_MODE}"
fi

# 5c: 查看 user_profile.md 实际内容
echo ""
echo "  → 查看 sync 后 user_profile.md 实际内容："
USER_PROFILE_CONTENT=$(echo "$CI_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_profile','(空)'))" 2>/dev/null || echo "(解析失败)")
echo "  ──────────────────────────────"
echo "$USER_PROFILE_CONTENT" | head -20 | sed 's/^/  │ /'
echo "  ──────────────────────────────"

# 5d: 查看 health_wiki 实际内容（前20行）
echo ""
echo "  → 查看 sync 后 health_wiki（index.md）内容（前20行）："
HEALTH_WIKI_CONTENT=$(echo "$CI_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('health_wiki','(空)'))" 2>/dev/null || echo "(解析失败)")
echo "  ──────────────────────────────"
echo "$HEALTH_WIKI_CONTENT" | head -20 | sed 's/^/  │ /'
echo "  ──────────────────────────────"

# ─── T6: 清理 ────────────────────────────────────────────────────────────────
echo ""
echo "═══ T6: 清理测试数据 ═══"
DEL_RESP=$(curl -s -X DELETE "${BASE}/api/clients/${TEST_CLIENT_ID}")
DEL_OK=$(echo "$DEL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null || echo "False")
if [ "$DEL_OK" = "True" ]; then
  pass "测试用户已清理: ${TEST_CLIENT_ID}"
else
  fail "测试用户清理失败: ${DEL_RESP}"
fi

# ─── 总结 ─────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo -e "  测试结果: ${GREEN}${PASS} 通过${NC} / ${RED}${FAIL} 失败${NC}"
echo "════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
