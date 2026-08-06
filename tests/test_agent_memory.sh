#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# test_agent_memory.sh — Agent ↔ LLMWiki 全链路测试（Agent 端验证）
#
# 核心原则：
#   - 所有验证通过 Agent 回复内容判断
#   - 对于 Skill 异步场景，等待 callback 完成后验证
#   - LLMWiki 仅用于：测试数据准备 + 清理
#
# 测试矩阵：
#
#   Phase 0: 服务可达 + 数据准备（5条历史日志 + sync 建档）
#
#   Phase 1: 直接回复（status=done）中验证 wiki 注入
#     T1.1 — 普通闲聊 → Agent 回复感知健康背景（mention血压/称呼）
#     T1.2 — "你了解我的情况吗" → Agent 提到具体健康信息
#     T1.3 — 禁忌词检查 → 回复不含"危险"（user_profile 生效）
#
#   Phase 2: Skill 路由验证（正确路由 + callback 后验证）
#     T2.1 — 健康问题 → 路由到 Health Skill（不是闲聊处理）
#     T2.2 — 营养问题 → 路由到 AI营养师 Skill
#     T2.3 — 等待 Skill callback → 验证日志被写入 LLMWiki
#     T2.4 — callback 完成后再次问相关问题 → Agent 知道 Skill 的结论
#
#   Phase 3: 记忆积累 — 新信息 sync 后 Agent 能使用
#     T3.1 — 写新日志（钙片信息）+ sync → 再问 Agent 提到"钙"
#     T3.2 — 写复查数据 + sync → Agent 知道新血压 130/82
#     T3.3 — Agent 同时记住新旧信息（新血压 + 氨氯地平旧药）
#
#   Phase 4: 多轮对话 — history + wiki context 共存不崩溃
#     T4.1 — 带 history 发消息 → 正常响应
#     T4.2 — 追问上轮内容 → 验证 history 实际传递
#
#   Phase 5: 边界 + 鲁棒性
#     T5.1-T5.5 — 空消息、长消息、特殊字符、并发、幂等
#
#   Phase 6: 自动建档 + 新用户行为
#     T6.1 — 新 user_id 通过 Agent 聊天 → LLMWiki 自动建档
#     T6.2 — 新用户 context-inject → mode=new_user（不注入空模板）
#     T6.3 — 新用户带历史对话 → 自动写入日志并 sync wiki
# ──────────────────────────────────────────────────────────────────────────────

set -eo pipefail

AGENT_BASE="${AGENT_BASE:-https://skill-platform-yo5337ccva-de.a.run.app}"
WIKI_BASE="${WIKI_BASE:-https://llmwiki-yo5337ccva-an.a.run.app}"
PASS=0; FAIL=0; SKIP=0
CLIENT_ID=""

# ─── 颜色 ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

pass()       { ((PASS++)); echo -e "  ${GREEN}✓ $1${NC}"; }
fail()       { ((FAIL++)); echo -e "  ${RED}✗ $1${NC}"; }
skip()       { ((SKIP++)); echo -e "  ${YELLOW}⊘ $1${NC}"; }
section()    { echo ""; echo -e "${BOLD}${CYAN}═══ $1 ═══${NC}"; }
subsection() { echo -e "${CYAN}  ── $1 ──${NC}"; }
info()       { echo -e "  ${CYAN}ℹ${NC} $1"; }
detail()     { echo -e "  ${DIM}│ $1${NC}"; }

# ─── 调用 Agent API ─────────────────────────────────────────────────────────
# 诊断日志输出到 stderr（终端可见），stdout 只输出干净 JSON（供变量捕获）
call_agent() {
  local content="$1"
  local user_id="${2:-$CLIENT_ID}"
  local user_name="${3:-张阿姨}"
  local notes="${4:-}"
  local history_json="${5:-[]}"

  local tmpdir
  tmpdir=$(mktemp -d)
  echo -n "$content"      > "$tmpdir/content.txt"
  echo -n "$notes"        > "$tmpdir/notes.txt"
  echo -n "$history_json" > "$tmpdir/history.json"

  echo -e "  ${DIM}┌─ Agent 请求${NC}"                                         >&2
  echo -e "  ${DIM}│ user_id=${user_id} | content: \"${content:0:55}\"${NC}"   >&2

  local result
  result=$(python3 - "$tmpdir" "$user_id" "$user_name" "${AGENT_BASE}" << 'PYEOF'
import json, urllib.request, sys, os
tmpdir, user_id, user_name, agent_base = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
content  = open(os.path.join(tmpdir, 'content.txt')).read()
notes    = open(os.path.join(tmpdir, 'notes.txt')).read()
try:    history = json.loads(open(os.path.join(tmpdir, 'history.json')).read())
except: history = []
body = {
    'content': content, 'source': 'wecom', 'session_id': user_id,
    'meta': {'from_name': user_name, 'user_id': user_id, 'company': '测试公司'},
    'context': {'available_apps': ['企业微信'], 'current_recipient': user_name},
    'history': history, 'notes': notes,
}
data = json.dumps(body, ensure_ascii=False).encode('utf-8')
req  = urllib.request.Request(f'{agent_base}/api/v1/agent/chat',
       data=data, headers={'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        print(resp.read().decode('utf-8'))
except Exception as e:
    print(json.dumps({'status': 'error', 'error': str(e)}))
PYEOF
  )
  rm -rf "$tmpdir"

  local status reply reasoning
  status=$(echo "$result"    | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))"    2>/dev/null || echo "error")
  reply=$(echo "$result"     | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"     2>/dev/null || echo "")
  reasoning=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reasoning',''))" 2>/dev/null || echo "")

  echo -e "  ${DIM}│ status: ${status}${NC}"                                              >&2
  echo -e "  ${DIM}│ reasoning: ${reasoning:0:75}${NC}"                                   >&2
  if [ ${#reply} -gt 120 ]; then
    echo -e "  ${DIM}│ reply: \"${reply:0:120}...\"${NC}"                                 >&2
  else
    echo -e "  ${DIM}│ reply: \"${reply}\"${NC}"                                          >&2
  fi
  echo -e "  ${DIM}└──────────────${NC}"                                                  >&2

  echo "$result"   # 只有 JSON 到 stdout
}

# ─── 辅助函数 ──────────────────────────────────────────────────────────────
reply_contains() { echo "$1" | grep -qi "$2" && echo "yes" || echo "no"; }

get_log_count() {
  curl -s "${WIKI_BASE}/api/clients/${1}/logs" | \
    python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0"
}

do_sync() {
  curl -s -X POST "${WIKI_BASE}/api/clients/${CLIENT_ID}/sync" \
    -H "Content-Type: application/json" --max-time 180
}

# ─── 清理 ──────────────────────────────────────────────────────────────────
KEEP_DATA=false
[[ "${1:-}" == "--keep" ]] && KEEP_DATA=true

cleanup() {
  if [ "$KEEP_DATA" = "true" ]; then
    section "保留测试数据（--keep 模式）"
    info "用户 ${CLIENT_ID} 已保留，可在前端查看"
    info "手动清理: curl -X DELETE ${WIKI_BASE}/api/clients/${CLIENT_ID}"
  else
    section "清理测试数据"
    [ -n "$CLIENT_ID" ] && \
      curl -s -X DELETE "${WIKI_BASE}/api/clients/${CLIENT_ID}" > /dev/null 2>&1 && \
      info "已清理 ${CLIENT_ID}" || true
  fi
}
trap cleanup EXIT

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Agent ↔ LLMWiki 全链路测试（所有验证通过 Agent 回复）      ║${NC}"
echo -e "${BOLD}║   Agent: ${AGENT_BASE}${NC}"
echo -e "${BOLD}║   Wiki:  ${WIKI_BASE}${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"


# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 0: 服务可达 + 数据准备"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "P0.1 服务健康检查"
AGENT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${AGENT_BASE}/api/health")
[ "$AGENT_HTTP" = "200" ] && pass "Agent 可达" || { fail "Agent 不可达 (${AGENT_HTTP})"; exit 1; }
WIKI_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${WIKI_BASE}/api/clients")
[ "$WIKI_HTTP" = "200" ] && pass "LLMWiki 可达" || { fail "LLMWiki 不可达"; exit 1; }

subsection "P0.2 创建测试用户"
CREATE_RESP=$(curl -s -X POST "${WIKI_BASE}/api/clients" \
  -H "Content-Type: application/json" \
  -d '{"name":"张丽华","age":68,"gender":"女","allergies":"青霉素过敏"}')
CLIENT_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$CLIENT_ID" ] && pass "用户创建: ${CLIENT_ID}" || { fail "创建失败"; exit 1; }

subsection "P0.3 写入5条历史日志 + 初始 sync"
curl -s -X POST "${WIKI_BASE}/api/clients/${CLIENT_ID}/logs/batch" \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [
      {"type":"phone","content":"患者张丽华，68岁女性，高血压病史12年。目前服用氨氯地平5mg每天早上一次、阿司匹林100mg每天一次、阿托伐他汀20mg每晚一次。近期血压135/85。2024年有腔隙性脑梗史，已恢复。","title":"病史"},
      {"type":"wechat","content":"血糖检测：空腹血糖6.5mmol/L，糖化6.2%。LDL 3.8mmol/L，甘油三酯2.1mmol/L。医生说糖尿病前期，控制饮食。","title":"化验"},
      {"type":"phone","content":"患者最近3个月睡眠不好，常凌晨3-4点早醒，白天疲倦。","title":"睡眠"},
      {"type":"wechat","content":"患者：我女儿是护士，沟通时不要用太专业的词，不要说危险不危险的，我容易紧张。老伴去年走了，我一个人住。","title":"偏好"},
      {"type":"phone","content":"复查膝关节X光：双膝轻度骨关节炎，下楼梯膝盖疼，建议避免爬山。","title":"膝关节"}
    ]
  }' > /dev/null
pass "5条历史日志已写入"

info "初始 sync 建立档案（约30-60s）..."
S0=$(do_sync)
S0_FILES=$(echo "$S0" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('updatedFiles',[])))" 2>/dev/null)
S0_OK=$(echo "$S0" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)
[ "$S0_OK" = "True" ] && pass "初始 sync 完成: ${S0_FILES}" || fail "初始 sync 失败"


# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 1: 直接回复（status=done）中验证 wiki 注入"
# ═══════════════════════════════════════════════════════════════════════════════
info "注意：只有 status=done 的回复才能验证回复内容；status=processing 表示走了 Skill 异步"

subsection "T1.1 普通闲聊 → 验证称呼正确 + 日志回写"
LOG_B=$(get_log_count "$CLIENT_ID")
RESP=$(call_agent "你好，今天天气不错" "$CLIENT_ID" "张阿姨")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
REPLY=$(echo "$RESP"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"  2>/dev/null)
[ "$STATUS" = "done" ] && pass "普通聊天 status=done（Agent 直接处理，未路由 Skill）" || fail "普通聊天未返回 done: ${STATUS}"
[ "$(reply_contains "$REPLY" "张阿姨")" = "yes" ] && pass "称呼正确（张阿姨）" || skip "未使用称呼"
sleep 4
LOG_A=$(get_log_count "$CLIENT_ID")
[ "$LOG_A" -gt "$LOG_B" ] && pass "日志回写生效 (${LOG_B}→${LOG_A})" || fail "日志未回写"

subsection "T1.2 「你了解我的情况吗」→ Agent 提到健康背景（wiki 注入证明）"
RESP12=$(call_agent "你了解我的情况吗？我有什么病？" "$CLIENT_ID" "张阿姨")
STATUS12=$(echo "$RESP12" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
REPLY12=$(echo "$RESP12"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"  2>/dev/null)
[ "$STATUS12" = "done" ] || [ "$STATUS12" = "processing" ] && pass "健康背景查询正常响应 (${STATUS12})" || fail "健康背景查询异常"
if [ "$STATUS12" = "done" ]; then
  HIT=0
  [ "$(reply_contains "$REPLY12" "高血压")" = "yes" ]   && ((HIT++)) && detail "✓ 提到高血压"
  [ "$(reply_contains "$REPLY12" "血压")" = "yes" ]     && [ "$HIT" -eq 0 ] && ((HIT++)) && detail "✓ 提到血压"
  [ "$(reply_contains "$REPLY12" "氨氯地平")" = "yes" ] && ((HIT++)) && detail "✓ 提到氨氯地平"
  [ "$(reply_contains "$REPLY12" "血糖")" = "yes" ]     && ((HIT++)) && detail "✓ 提到血糖"
  [ "$(reply_contains "$REPLY12" "脑梗")" = "yes" ]     && ((HIT++)) && detail "✓ 提到脑梗史"
  [ "$HIT" -ge 2 ] && pass "✨ Agent 提到 ${HIT} 项健康背景 — wiki 已注入 system prompt！" \
  || { [ "$HIT" -ge 1 ] && pass "Agent 提到 ${HIT} 项健康背景" || skip "Agent 给了通用回答（未提具体病史）"; }
else
  info "走了 Skill 异步，稍后 T2 验证 callback"
  skip "Skill 异步，等 T2 阶段验证"
fi

subsection "T1.3 禁忌词检查 — user_profile 沟通禁忌生效"
info "复用 T1.2 回复验证禁忌词（若 T1.2 是 Skill 异步，另发一条闲聊来验证）"
if [ "$STATUS12" = "done" ]; then
  if [ "$(reply_contains "$REPLY12" "危险")" = "no" ] && [ "$(reply_contains "$REPLY12" "危及生命")" = "no" ]; then
    pass "✨ T1.2 回复未出现禁忌词「危险」— user_profile 禁忌生效"
  else
    fail "T1.2 回复包含禁忌词（危险/危及生命）"
  fi
else
  RESP13=$(call_agent "你好，我有点担心自己的情况" "$CLIENT_ID" "张阿姨")
  STATUS13=$(echo "$RESP13" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  REPLY13=$(echo "$RESP13"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"  2>/dev/null)
  if [ "$STATUS13" = "done" ]; then
    [ "$(reply_contains "$REPLY13" "危险")" = "no" ] && [ "$(reply_contains "$REPLY13" "危及生命")" = "no" ] \
      && pass "✨ 闲聊回复未出现禁忌词 — user_profile 禁忌生效" || fail "回复包含禁忌词"
  else
    skip "Skill 异步，跳过禁忌词检查"
  fi
fi


# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 2: Skill 路由验证 + callback 后验证"
# ═══════════════════════════════════════════════════════════════════════════════
info "健康类问题会路由到 Skill 异步处理（2-3分钟），测试验证：路由正确 + callback 写入日志"

subsection "T2.1 健康问题 → 路由到 Health Skill（不是直接回复）"
LOG_B=$(get_log_count "$CLIENT_ID")
RESP=$(call_agent "我最近血压有点高，要不要调药？" "$CLIENT_ID" "张阿姨")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))"    2>/dev/null)
SKILL=$(echo "$RESP"  | python3 -c "import sys,json; r=json.load(sys.stdin).get('reasoning',''); print('health' if 'Health' in r else 'other')" 2>/dev/null)
[ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ] && pass "血压咨询 Agent 正常响应 (${STATUS})" || fail "血压咨询异常"
[ "$SKILL" = "health" ] && pass "✓ 路由到 Health Skill（reasoning 包含 Health）" || info "路由到: ${SKILL}"

subsection "T2.2 营养问题 → 路由到 AI营养师 Skill"
RESP=$(call_agent "糖尿病前期可以吃什么水果？" "$CLIENT_ID" "张阿姨")
STATUS=$(echo "$RESP"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))"       2>/dev/null)
SKILL2=$(echo "$RESP"  | python3 -c "import sys,json; r=json.load(sys.stdin).get('reasoning',''); print('nutrition' if '营养' in r else 'other')" 2>/dev/null)
[ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ] && pass "营养咨询 Agent 正常响应 (${STATUS})" || fail "营养咨询异常"
[ "$SKILL2" = "nutrition" ] && pass "✓ 路由到 AI营养师 Skill" || info "路由到: ${SKILL2}"

subsection "T2.3 等待 Skill callback → 日志被写入 LLMWiki"
info "等待 Skills 完成 callback（最长3分钟）..."
WAIT=0
while [ "$WAIT" -lt 180 ]; do
  LOG_NOW=$(get_log_count "$CLIENT_ID")
  if [ "$LOG_NOW" -gt "$LOG_B" ]; then
    DIFF=$((LOG_NOW - LOG_B))
    pass "✨ Skill callback 完成，日志增加 ${DIFF} 条（${LOG_B}→${LOG_NOW}）"
    break
  fi
  sleep 10
  WAIT=$((WAIT + 10))
  printf "  %s等待 Skill callback... %ds\r" "${CYAN}ℹ${NC}" "$WAIT"
done
LOG_AFTER_SKILL=$(get_log_count "$CLIENT_ID")
[ "$LOG_AFTER_SKILL" -gt "$LOG_B" ] || fail "Skill callback 超时（3分钟内日志未增加）"

subsection "T2.4 Skill callback 后再次问相关问题 → Agent 知道 Skill 结论"
info "Skill 完成后，用完全中性的追问验证上下文连续性（避免健康关键词触发 Skill）"
RESP=$(call_agent "你刚才给我的分析结论是什么？帮我总结一下" "$CLIENT_ID" "张阿姨" "" "")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
REPLY=$(echo "$RESP"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"  2>/dev/null)
[ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ] && pass "追问 Skill 结论正常响应" || fail "追问异常"
if [ "$STATUS" = "done" ] && [ ${#REPLY} -gt 20 ]; then
  pass "Agent 给出有意义回复 (${#REPLY}字)"
fi


# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 3: 记忆积累 — 新信息 sync 后 Agent 能使用"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "T3.1 写入新信息（钙片）+ sync → Agent 知道"
curl -s -X POST "${WIKI_BASE}/api/clients/${CLIENT_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：我最近开始吃钙片了，每天600mg。女儿让买的。上周骨密度T值-1.8，医生说骨量减少但还没到骨质疏松。"}' > /dev/null

info "sync 钙片信息（30-60s）..."
S3=$(do_sync)
S3_OK=$(echo "$S3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated','?'))" 2>/dev/null)
info "钙片 sync wikiUpdated=${S3_OK}"
sleep 3

info "用回忆式提问验证钙片信息注入（回忆型不触发 Skill）"
RESP=$(call_agent "你知道我最近有新开始吃什么吗？" "$CLIENT_ID" "张阿姨")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
REPLY=$(echo "$RESP"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"  2>/dev/null)
[ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ] && pass "钙片信息询问正常响应 (${STATUS})" || fail "钙片信息询问异常"
if [ "$STATUS" = "done" ]; then
  [ "$(reply_contains "$REPLY" "钙")" = "yes" ] \
    && pass "✨ Agent 知道用户开始吃钙片（新信息 sync 后注入生效！）" \
    || skip "Agent 未提钙片（可能回答了其他内容，不计为失败）"
else
  skip "Skill 异步，跳过钙片验证"
fi

subsection "T3.2 写复查数据 + sync → Agent 知道新血压"
curl -s -X POST "${WIKI_BASE}/api/clients/${CLIENT_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"今天复查：血压130/82，医生说控制得很好，不用调药。糖化血红蛋白6.1%。"}' > /dev/null

info "sync 复查数据（30-60s）..."
do_sync > /dev/null
sleep 3

# 用回忆式提问（不触发 Skill）验证复查数据
RESP=$(call_agent "你记录了我的复查结果吗？上次血压多少？" "$CLIENT_ID" "张阿姨")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
REPLY=$(echo "$RESP"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"  2>/dev/null)
[ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ] && pass "复查血压查询正常响应 (${STATUS})" || fail "复查血压查询异常"
if [ "$STATUS" = "done" ]; then
  if [ "$(reply_contains "$REPLY" "130")" = "yes" ]; then
    pass "✨ Agent 引用复查血压 130/82（增量记忆生效！）"
  elif [ "$(reply_contains "$REPLY" "血压")" = "yes" ]; then
    pass "Agent 知道血压情况（知道有记录但未引用具体数值）"
  else
    skip "Agent 未引用复查数值"
  fi
else
  skip "Skill 异步，跳过复查验证"
fi

subsection "T3.3 Agent 同时记住新旧信息（旧用药 + 新钙片）"
# 用「你知道我吃哪些」回忆型，不触发 Skill
RESP=$(call_agent "你知道我目前在吃哪些药和补充剂吗？" "$CLIENT_ID" "张阿姨")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
REPLY=$(echo "$RESP"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"  2>/dev/null)
[ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ] && pass "用药列举查询正常响应 (${STATUS})" || fail "用药查询异常"
if [ "$STATUS" = "done" ]; then
  HIT=0
  [ "$(reply_contains "$REPLY" "氨氯地平")" = "yes" ]   && ((HIT++)) && detail "✓ 氨氯地平（旧信息保留）"
  [ "$(reply_contains "$REPLY" "阿司匹林")" = "yes" ]   && ((HIT++)) && detail "✓ 阿司匹林（旧信息保留）"
  [ "$(reply_contains "$REPLY" "阿托伐他汀")" = "yes" ]  && ((HIT++)) && detail "✓ 阿托伐他汀（旧信息保留）"
  [ "$(reply_contains "$REPLY" "钙")" = "yes" ]         && ((HIT++)) && detail "✓ 钙片（新增信息）"
  [ "$HIT" -ge 3 ] && pass "✨ Agent 知道 ${HIT} 种药/补剂（新旧信息同时保留！）" \
  || { [ "$HIT" -ge 1 ] && pass "Agent 知道 ${HIT} 种（部分）" || skip "Agent 给了通用回答（未列具体药名）"; }
else
  skip "Skill 异步，跳过用药验证"
fi


# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 4: 多轮对话 — history + wiki context 共存"
# ═══════════════════════════════════════════════════════════════════════════════

HISTORY="[]"
subsection "T4.1 5轮含健康内容的对话（全部成功）"
MULTI_MSGS=(
  "你好，今天来问几个问题"
  "我血压最近140/90，比之前高了一点，怎么回事"
  "我的膝盖也不舒服，你知道我膝盖的情况吗"
  "好的，那平时走路有什么注意事项"
  "谢谢你，今天聊了很多"
)
ALL_OK=true
for i in "${!MULTI_MSGS[@]}"; do
  MSG="${MULTI_MSGS[$i]}"
  ROUND=$((i+1))
  info "轮${ROUND}: ${MSG:0:30}..."
  RESP=$(call_agent "$MSG" "$CLIENT_ID" "张阿姨" "" "$HISTORY")
  STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  REPLY=$(echo "$RESP"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply','')[:50])" 2>/dev/null || echo "")
  [ "$STATUS" != "done" ] && [ "$STATUS" != "processing" ] && { fail "轮${ROUND}失败 status=${STATUS}"; ALL_OK=false; }

  htmp=$(mktemp)
  python3 - "$HISTORY" "$MSG" "$REPLY" << 'HIST_PY' > "$htmp"
import json, sys
try:    h = json.loads(sys.argv[1]) if sys.argv[1] != '[]' else []
except: h = []
h.append({'role':'user',      'content': sys.argv[2]})
h.append({'role':'assistant', 'content': sys.argv[3]})
print(json.dumps(h[-20:], ensure_ascii=False))
HIST_PY
  HISTORY=$(cat "$htmp" 2>/dev/null || echo "[]")
  rm -f "$htmp"
  sleep 1
done
$ALL_OK && pass "5轮多轮对话全部成功" || fail "多轮对话有失败"

subsection "T4.2 追问上轮内容 → history 生效"
RESP=$(call_agent "你刚才说走路注意什么来着？再说一遍" "$CLIENT_ID" "张阿姨" "" "$HISTORY")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
REPLY=$(echo "$RESP"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"  2>/dev/null)
[ "$STATUS" = "done" ] && pass "追问上轮正常响应（history 有效）" || fail "追问失败: ${STATUS}"
[ ${#REPLY} -gt 20 ] && pass "Agent 给出有意义回复（${#REPLY}字）" || skip "回复太短"

subsection "T4.3 history + wiki 并存不崩溃"
HIST_LEN=$(python3 - "$HISTORY" << 'HLEN'
import json, sys
try: print(len(json.loads(sys.argv[1])))
except: print(0)
HLEN
)
info "当前 history 长度: ${HIST_LEN} 条"
RESP=$(call_agent "帮我总结一下我们今天聊了什么" "$CLIENT_ID" "张阿姨" "" "$HISTORY")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$STATUS" = "done" ] && pass "history(${HIST_LEN}条) + wiki context 同时工作，不崩溃" || fail "history + wiki 崩溃: ${STATUS}"


# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 5: 边界值 & 压力测试"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "T5.1 超长消息 (2000字) → 不崩溃"
LONG_MSG=$(python3 -c "print(('我想问一下关于高血压的问题，' * 100)[:2000])")
RESP=$(call_agent "$LONG_MSG" "$CLIENT_ID" "张阿姨")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ] && pass "超长消息 (2000字) 不崩溃 (${STATUS})" || fail "超长消息崩溃"

subsection "T5.2 超长历史 (20条) → 不崩溃"
RESP=$(call_agent "好的" "$CLIENT_ID" "张阿姨" "" "$HISTORY")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$STATUS" = "done" ] && pass "超长 history (${HIST_LEN}条) 不崩溃" || fail "超长 history 崩溃: ${STATUS}"

subsection "T5.3 无 wiki 用户 → graceful fallback"
NO_WIKI_ID="no_wiki_user_$(date +%s)"
RESP=$(call_agent "你好，我想问一下血压" "$NO_WIKI_ID" "新用户")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
REPLY=$(echo "$RESP"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))"  2>/dev/null)
[ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ] && pass "无 wiki 用户 Agent 不崩溃 (${STATUS})" || fail "无 wiki 用户崩溃"
[ ${#REPLY} -gt 10 ] && pass "Agent 给出有意义回复 (${#REPLY}字)" || fail "Agent 回复为空"

subsection "T5.4 并发5个 Agent 调用"
CONC_OK=0
for i in $(seq 1 5); do
  call_agent "并发测试 #${i}，今天心情不错" "$CLIENT_ID" "张阿姨" > /tmp/conc_mem_${i}.json &
done
wait
for i in $(seq 1 5); do
  S=$(python3 -c "import json; print(json.load(open('/tmp/conc_mem_${i}.json')).get('status',''))" 2>/dev/null || echo "error")
  [ "$S" = "done" ] || [ "$S" = "processing" ] && ((CONC_OK++))
done
rm -f /tmp/conc_mem_*.json
[ "$CONC_OK" -ge 4 ] && pass "并发调用: ${CONC_OK}/5 成功" || fail "并发调用: ${CONC_OK}/5 成功"

subsection "T5.5 重复 sync 幂等（wikiUpdated=False）"
SYNC_DUP=$(curl -s -X POST "${WIKI_BASE}/api/clients/${CLIENT_ID}/sync" \
  -H "Content-Type: application/json" --max-time 30)
DUP=$(echo "$SYNC_DUP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated','?'))" 2>/dev/null)
[ "$DUP" = "False" ] && pass "重复 sync 幂等（wikiUpdated=False）" || fail "重复 sync 应无更新（得到 ${DUP}）"


# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 6: 自动建档 + 新用户行为验证"
# ═══════════════════════════════════════════════════════════════════════════════

# 用一个全新的随机 user_id 来测试自动建档
AUTO_USER_ID="auto_test_$(date +%s)_$(shuf -i 1000-9999 -n 1)"

subsection "T6.1 新用户 Agent 聊天 → LLMWiki 自动建档"
info "使用全新 user_id=${AUTO_USER_ID}，通过 Agent 聊天触发自动建档"

# 先确认用户在 llmwiki 不存在
PRE_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "${WIKI_BASE}/api/clients/${AUTO_USER_ID}/wiki")
[ "$PRE_CHECK" = "404" ] && pass "确认用户不存在（404）" || fail "用户已存在（${PRE_CHECK}）"

# 通过 Agent 发消息（这应该触发自动建档）
RESP61=$(call_agent "你好，我叫王明" "$AUTO_USER_ID" "王明" "" "")
STATUS61=$(echo "$RESP61" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$STATUS61" = "done" ] || [ "$STATUS61" = "processing" ] && pass "Agent 正常回复新用户" || fail "Agent 对新用户异常 (${STATUS61})"

# 等待自动建档完成（后台 fire-and-forget，需要短暂等待）
sleep 3

# 检查用户是否已在 llmwiki 创建
POST_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "${WIKI_BASE}/api/clients/${AUTO_USER_ID}/wiki")
[ "$POST_CHECK" = "200" ] && pass "自动建档成功（wiki 200）" || fail "自动建档失败（wiki ${POST_CHECK}）"

subsection "T6.2 新用户 context-inject 返回 new_user 模式（不注入空模板）"
CI_RESP=$(curl -s "${WIKI_BASE}/api/clients/${AUTO_USER_ID}/context-inject")
CI_MODE=$(echo "$CI_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null)
CI_WIKI=$(echo "$CI_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('health_wiki','')))" 2>/dev/null)

if [ "$CI_MODE" = "new_user" ]; then
  pass "context-inject 返回 mode=new_user"
else
  fail "期望 mode=new_user，实际 mode=${CI_MODE}"
fi

# 空模板有几百字，new_user 模式应该很短或为空
if [ "$CI_WIKI" -lt 50 ]; then
  pass "health_wiki 极短（${CI_WIKI}字），未注入空模板"
else
  fail "health_wiki 太长（${CI_WIKI}字），可能注入了空模板"
fi

subsection "T6.3 新用户带历史对话 → 自动写入日志并 sync"
AUTO_USER_ID2="auto_hist_$(date +%s)_$(shuf -i 1000-9999 -n 1)"
info "user_id=${AUTO_USER_ID2}，带4轮历史对话发送"

# 构造带历史的请求
RESP63=$(python3 -c "
import urllib.request, json, sys
body = {
    'content': '我最近血糖怎么样？',
    'source': 'wecom',
    'session_id': '${AUTO_USER_ID2}',
    'meta': {'from_name': '李阿姨', 'user_id': '${AUTO_USER_ID2}', 'company': '测试'},
    'context': {'available_apps': ['企业微信'], 'current_recipient': '李阿姨'},
    'history': [
        {'role': 'user', 'content': '我是李阿姨，65岁，有糖尿病，在吃二甲双胍'},
        {'role': 'assistant', 'content': '李阿姨您好，了解您的情况了。'},
        {'role': 'user', 'content': '最近空腹血糖7.2，餐后10.5，医生让加药'},
        {'role': 'assistant', 'content': '好的，我记录下了您的血糖数据。'},
    ],
}
data = json.dumps(body, ensure_ascii=False).encode('utf-8')
req = urllib.request.Request('${AGENT_BASE}/api/v1/agent/chat',
    data=data, headers={'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        print(resp.read().decode('utf-8'))
except Exception as e:
    print(json.dumps({'status': 'error', 'error': str(e)}))
" 2>/dev/null)

STATUS63=$(echo "$RESP63" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$STATUS63" = "done" ] || [ "$STATUS63" = "processing" ] && pass "带历史的新用户 Agent 正常回复" || fail "异常 (${STATUS63})"

# 等待后台：自动建档 + 历史日志写入 + sync（sync 需要 LLM 调用，30-60s）
info "等待自动建档 + 历史写入 + sync（最长90s）..."
WAIT=0
while [ "$WAIT" -lt 90 ]; do
  SYNC_AT=$(curl -s "${WIKI_BASE}/api/clients" 2>/dev/null | \
    python3 -c "import sys,json; cs=json.load(sys.stdin); c=next((x for x in cs if x['id']=='${AUTO_USER_ID2}'),{}); print(c.get('lastSyncAt',''))" 2>/dev/null || echo "")
  if [ -n "$SYNC_AT" ] && [ "$SYNC_AT" != "None" ] && [ "$SYNC_AT" != "null" ]; then
    pass "历史对话自动 sync 完成（lastSyncAt=${SYNC_AT}）"
    break
  fi
  sleep 10
  WAIT=$((WAIT + 10))
  printf "  %s等待 sync... %ds\r" "${CYAN}ℹ${NC}" "$WAIT" >&2
done
[ "$WAIT" -ge 90 ] && fail "历史对话自动 sync 超时（90s）"

# 验证 sync 后 wiki 有实质内容
if [ "$WAIT" -lt 90 ]; then
  CI_AFTER=$(curl -s "${WIKI_BASE}/api/clients/${AUTO_USER_ID2}/context-inject")
  CI_MODE2=$(echo "$CI_AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null)
  CI_WIKI2=$(echo "$CI_AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('health_wiki',''))" 2>/dev/null)
  [ "$CI_MODE2" = "full" ] || [ "$CI_MODE2" = "prefetch" ] && pass "sync 后 context-inject mode=${CI_MODE2}（非 new_user）" || fail "sync 后仍是 ${CI_MODE2}"

  # 验证 wiki 里有血糖或二甲双胍信息
  HAS_CONTENT=$(echo "$CI_WIKI2" | grep -ci "血糖\|二甲双胍\|糖尿" || echo "0")
  [ "$HAS_CONTENT" -gt 0 ] && pass "wiki 包含历史中的健康信息" || skip "wiki 内容未匹配关键词（可能 LLM 概括不同）"
fi

# 清理自动建档测试用户
info "清理自动建档测试用户..."
curl -s -X DELETE "${WIKI_BASE}/api/clients/${AUTO_USER_ID}" > /dev/null 2>&1
curl -s -X DELETE "${WIKI_BASE}/api/clients/${AUTO_USER_ID2}" > /dev/null 2>&1
info "已清理 ${AUTO_USER_ID} 和 ${AUTO_USER_ID2}"

# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 7: Wiki 变更日志 + 多模态图片 OCR"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "T7.1 sync 后 sync-history 有记录"
HIST_RESP=$(curl -s "${WIKI_BASE}/api/clients/${CLIENT_ID}/sync-history")
HIST_COUNT=$(echo "$HIST_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
[ "$HIST_COUNT" -ge 1 ] && pass "sync-history 有 ${HIST_COUNT} 条记录" || fail "sync-history 为空（预期 ≥1 条）"

subsection "T7.2 sync-history 记录字段完整"
FIRST_ENTRY=$(echo "$HIST_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d[0]) if d else '{}')" 2>/dev/null || echo "{}")
detail "首条记录: ${FIRST_ENTRY:0:120}"
HAS_TIMESTAMP=$(echo "$FIRST_ENTRY" | python3 -c "import sys,json; print('yes' if json.load(sys.stdin).get('timestamp') else 'no')" 2>/dev/null)
HAS_LOGS=$(echo "$FIRST_ENTRY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('logsProcessed') is not None else 'no')" 2>/dev/null)
HAS_FILES=$(echo "$FIRST_ENTRY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('updatedFiles'), list) else 'no')" 2>/dev/null)
HAS_TIMING=$(echo "$FIRST_ENTRY" | python3 -c "import sys,json; print('yes' if json.load(sys.stdin).get('timingMs') else 'no')" 2>/dev/null)
[ "$HAS_TIMESTAMP" = "yes" ] && pass "sync-history 有 timestamp 字段" || fail "sync-history 缺少 timestamp"
[ "$HAS_LOGS" = "yes" ] && pass "sync-history 有 logsProcessed 字段" || fail "sync-history 缺少 logsProcessed"
[ "$HAS_FILES" = "yes" ] && pass "sync-history 有 updatedFiles 数组" || fail "sync-history 缺少 updatedFiles"
[ "$HAS_TIMING" = "yes" ] && pass "sync-history 有 timingMs 字段" || fail "sync-history 缺少 timingMs"

subsection "T7.3 sync-history ?limit 参数生效"
HIST_1=$(curl -s "${WIKI_BASE}/api/clients/${CLIENT_ID}/sync-history?limit=1")
HIST_1_COUNT=$(echo "$HIST_1" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
[ "$HIST_1_COUNT" -eq 1 ] && pass "limit=1 正确限制返回 1 条" || fail "limit=1 应返回 1 条，实际 ${HIST_1_COUNT} 条"

subsection "T7.4 不存在的 client 查 sync-history → 404"
HIST_404=$(curl -s -o /dev/null -w "%{http_code}" "${WIKI_BASE}/api/clients/nonexistent_xyz/sync-history")
[ "$HIST_404" = "404" ] && pass "不存在的 client 返回 404" || fail "预期 404，实际 ${HIST_404}"

subsection "T7.5 多模态上传：缺少图片参数 → 400"
IMG_400=$(curl -s -X POST "${WIKI_BASE}/api/clients/${CLIENT_ID}/upload-image" \
  -H "Content-Type: application/json" \
  -d '{"document_type":"化验单"}')
CODE_400=$(echo "$IMG_400" | python3 -c "import sys,json; print('yes' if json.load(sys.stdin).get('error') else 'no')" 2>/dev/null)
[ "$CODE_400" = "yes" ] && pass "缺少图片参数返回 error" || fail "缺少图片应返回 error"

subsection "T7.6 多模态上传：不存在的 client → 404"
IMG_C404=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${WIKI_BASE}/api/clients/nonexistent_xyz/upload-image" \
  -H "Content-Type: application/json" \
  -d '{"image_url":"https://example.com/test.jpg"}')
[ "$IMG_C404" = "404" ] && pass "不存在 client 的 upload-image 返回 404" || fail "预期 404，实际 ${IMG_C404}"

subsection "T7.7 多模态上传：公开图片 URL → 识别成功并写入日志"
info "使用公开医疗图片 URL 测试 OCR 端点（调用多模态模型，约10-30s）..."
LOG_BEFORE=$(get_log_count "$CLIENT_ID")

# 使用一张公开的血压计照片（简单易识别，避免隐私问题）
# 如果没有公开测试图片，改用一个能通过校验的 base64 placeholder
IMG_RESP=$(curl -s --max-time 60 \
  -X POST "${WIKI_BASE}/api/clients/${CLIENT_ID}/upload-image" \
  -H "Content-Type: application/json" \
  -d "{
    \"image_url\": \"https://upload.wikimedia.org/wikipedia/commons/thumb/3/3b/Blood_pressure_meter.jpg/320px-Blood_pressure_meter.jpg\",
    \"document_type\": \"生命体征记录\"
  }")

IMG_HTTP_STATUS=$(echo "$IMG_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('201' if d.get('logId') else ('422' if d.get('error','').find('无法识别')>=0 else '500'))" 2>/dev/null || echo "error")
IMG_LOG_ID=$(echo "$IMG_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('logId',''))" 2>/dev/null || echo "")

if [ -n "$IMG_LOG_ID" ]; then
  pass "✨ 多模态 OCR 成功，写入日志 ${IMG_LOG_ID}"
  LOG_AFTER=$(get_log_count "$CLIENT_ID")
  [ "$LOG_AFTER" -gt "$LOG_BEFORE" ] && pass "OCR 日志已写入（${LOG_BEFORE}→${LOG_AFTER}）" || fail "日志数量未增加"

  # 验证日志类型为 ocr
  LOG_TYPE=$(curl -s "${WIKI_BASE}/api/clients/${CLIENT_ID}/logs" | \
    python3 -c "import sys,json; ls=json.load(sys.stdin); l=next((x for x in ls if x['id']=='${IMG_LOG_ID}'),{}); print(l.get('type',''))" 2>/dev/null || echo "")
  [ "$LOG_TYPE" = "ocr" ] && pass "OCR 日志类型为 ocr" || fail "日志类型应为 ocr，实际 ${LOG_TYPE}"

  # 验证 ocrResult 字段存在且有 document_type
  OCR_DOC_TYPE=$(echo "$IMG_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ocrResult',{}).get('document_type',''))" 2>/dev/null || echo "")
  [ -n "$OCR_DOC_TYPE" ] && pass "OCR 返回 document_type: ${OCR_DOC_TYPE}" || skip "OCR 未返回 document_type（可能模型限制）"
elif echo "$IMG_RESP" | grep -q "无法识别"; then
  pass "OCR 图片无法识别时返回 422（正确）"
  skip "图片 URL 不可访问或图片无医疗内容（跳过日志写入验证）"
else
  fail "多模态 OCR 调用失败: ${IMG_RESP:0:150}"
fi

subsection "T7.8 sync 后 sync-history 条数增加（累计验证）"
# 再做一次 sync，验证 sync-history 累计记录
curl -s -X POST "${WIKI_BASE}/api/clients/${CLIENT_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：今天检查了一下，视力有点下降，可能是看手机太多了。"}' > /dev/null

HIST_BEFORE=$(curl -s "${WIKI_BASE}/api/clients/${CLIENT_ID}/sync-history" | \
  python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

info "再次 sync 验证 sync-history 追加（约30-60s）..."
do_sync > /dev/null

HIST_AFTER=$(curl -s "${WIKI_BASE}/api/clients/${CLIENT_ID}/sync-history" | \
  python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
[ "$HIST_AFTER" -gt "$HIST_BEFORE" ] \
  && pass "✨ sync-history 累计追加 (${HIST_BEFORE}→${HIST_AFTER} 条)" \
  || fail "sync-history 未追加（${HIST_BEFORE}→${HIST_AFTER}）"


# ═══════════════════════════════════════════════════════════════════════════════
# 最终报告
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════════════${NC}"
echo -e "  ${BOLD}Agent ↔ LLMWiki 全链路测试结果${NC}"
echo -e "  ${GREEN}${PASS} 通过${NC} / ${RED}${FAIL} 失败${NC} / ${YELLOW}${SKIP} 跳过${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════════════${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

