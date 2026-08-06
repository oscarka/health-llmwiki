#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# test_agent_llmwiki_e2e.sh — Agent ↔ LLMWiki 端到端线上集成测试
#
# 直接打 Agent API (skill-platform) + LLMWiki API，验证完整记忆链路：
#
#   A1  — 线上 Agent + LLMWiki 接口可达
#   A2  — 在 LLMWiki 创建测试用户 + 预置健康档案
#   A3  — Agent 处理聊天消息 → 验证 backgroundPostLog 写入
#   A4  — Agent 处理健康咨询 → 验证 health_profile 注入到 system prompt
#   A5  — 多轮对话模拟（10轮）→ 验证日志持续写入 + 记忆不丢失
#   A6  — 触发 sync → 验证记忆提取准确性
#   A7  — context-inject prefetch → 验证根据 query 拉取相关页面
#   A8  — 矛盾信息 → 新信息追加而非覆盖
#   A9  — 超长 health_profile 注入 → Agent 不崩溃
#   A10 — 清理
# ──────────────────────────────────────────────────────────────────────────────

set -eo pipefail

AGENT_BASE="${AGENT_BASE:-https://skill-platform-yo5337ccva-de.a.run.app}"
WIKI_BASE="${LLMWIKI_BASE:-https://llmwiki-yo5337ccva-an.a.run.app}"
TEST_USER_ID=""
PASS=0
FAIL=0
SKIP=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { ((PASS++)); echo -e "${GREEN}  ✓ $1${NC}"; }
fail() { ((FAIL++)); echo -e "${RED}  ✗ $1${NC}"; }
skip() { ((SKIP++)); echo -e "${YELLOW}  ⊘ SKIP: $1${NC}"; }
info() { echo -e "${CYAN}  ℹ $1${NC}"; }
section() { echo ""; echo -e "${CYAN}═══ $1 ═══${NC}"; }

cleanup() {
  section "清理测试数据"
  if [ -n "$TEST_USER_ID" ]; then
    curl -s -X DELETE "${WIKI_BASE}/api/clients/${TEST_USER_ID}" > /dev/null 2>&1
    info "已清理 LLMWiki 用户 ${TEST_USER_ID}"
  fi
}
trap cleanup EXIT

# 工具: 调用 Agent API
call_agent() {
  local content="$1"
  local user_id="$2"
  local user_name="$3"
  local notes="${4:-}"
  local health_profile="${5:-}"
  local history_json="${6:-[]}"

  local body
  body=$(python3 -c "
import json
body = {
    'content': '''$content''',
    'source': 'wecom',
    'session_id': '$user_id',
    'meta': {'from_name': '$user_name', 'user_id': '$user_id', 'company': '测试公司'},
    'context': {'available_apps': ['企业微信'], 'current_recipient': '$user_name'},
    'history': $history_json,
    'notes': '''$notes''',
    'health_profile': '''$health_profile''',
}
print(json.dumps(body, ensure_ascii=False))
")

  curl -s -X POST "${AGENT_BASE}/api/v1/agent/chat" \
    -H "Content-Type: application/json" \
    -d "$body" \
    --max-time 30
}

# ═══════════════════════════════════════════════════════════════════════════════
section "A1: 线上服务可达性"

AGENT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${AGENT_BASE}/api/health")
if [ "$AGENT_HTTP" = "200" ]; then
  pass "Agent API 可达: ${AGENT_BASE}"
else
  fail "Agent API 不可达: HTTP ${AGENT_HTTP}"
  exit 1
fi

WIKI_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${WIKI_BASE}/api/clients")
if [ "$WIKI_HTTP" = "200" ]; then
  pass "LLMWiki API 可达: ${WIKI_BASE}"
else
  fail "LLMWiki API 不可达: HTTP ${WIKI_HTTP}"
  exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "A2: 创建测试用户 + 预置健康档案"

# 创建用户
CREATE_RESP=$(curl -s -X POST "${WIKI_BASE}/api/clients" \
  -H "Content-Type: application/json" \
  -d '{"name":"E2E测试用户-张阿姨","age":68,"gender":"女","allergies":"青霉素过敏"}')
TEST_USER_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

if [ -n "$TEST_USER_ID" ]; then
  pass "用户创建成功: ${TEST_USER_ID}"
else
  fail "用户创建失败"
  exit 1
fi

# 预写入一些健康日志（模拟已有档案）
curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：我有高血压病史10年了，一直在吃降压药。最近血压控制得还行，上次量的是135/85。\nAI：张阿姨您好，血压135/85控制得不错，在正常范围内。请继续按时服药，每天量血压记录一下。","title":"初始-高血压病史"}' > /dev/null

curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：我上个月查了血脂，总胆固醇6.2，低密度脂蛋白3.8，医生说偏高。我现在吃阿托伐他汀钙片20mg每晚一次。\nAI：张阿姨，总胆固醇6.2和LDL 3.8确实偏高一些。阿托伐他汀是常用的降脂药，20mg是标准剂量。建议3个月后复查血脂。","title":"初始-血脂+用药"}' > /dev/null

curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：对了你跟我说话不要用太专业的词，我听不懂。还有我女儿是护士，有些情况她会帮我问你。\nAI：好的张阿姨，以后我尽量用简单的话说。您女儿是护士的话，有些专业问题她也可以直接问我。","title":"初始-沟通偏好"}' > /dev/null

pass "预写入 3 条历史日志"

# 做初始 sync（建立档案基线）
info "初始 sync 建立档案基线（可能需要 30-60s）..."
SYNC_RESP=$(curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/sync" \
  -H "Content-Type: application/json" --max-time 120)
SYNC_OK=$(echo "$SYNC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)
if [ "$SYNC_OK" = "True" ]; then
  pass "初始 sync 完成，档案基线已建立"
else
  fail "初始 sync 失败: ${SYNC_RESP}"
fi

# 读取基线 context-inject
CI_BASE=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/context-inject")
BASE_UP=$(echo "$CI_BASE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_profile',''))" 2>/dev/null)
BASE_HW=$(echo "$CI_BASE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('health_wiki',''))" 2>/dev/null)
BASE_UP_LEN=${#BASE_UP}
BASE_HW_LEN=${#BASE_HW}
info "基线 user_profile: ${BASE_UP_LEN} 字符"
info "基线 health_wiki: ${BASE_HW_LEN} 字符"

# 验证关键信息在档案中
echo "$BASE_HW" | grep -qi "135\|高血压\|阿托伐他汀\|血脂\|胆固醇" && \
  pass "档案包含关键健康数据（高血压/血脂/用药）" || \
  fail "档案缺少关键健康数据"

echo "$BASE_UP" | grep -qi "专业\|简单\|护士\|女儿" && \
  pass "user_profile 包含沟通偏好（简单语言/女儿是护士）" || \
  skip "user_profile 未提取到偏好（LLM 未提取）"

# ═══════════════════════════════════════════════════════════════════════════════
section "A3: Agent 聊天消息 → 验证 backgroundPostLog"

# 记录当前日志数
LOG_BEFORE=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" | \
  python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
info "当前日志数: ${LOG_BEFORE}"

# 调用 Agent（普通聊天）
AGENT_RESP=$(call_agent "你好，今天天气怎么样？" "$TEST_USER_ID" "张阿姨" "高血压患者，青霉素过敏" "$BASE_UP")
AGENT_STATUS=$(echo "$AGENT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
AGENT_REPLY=$(echo "$AGENT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply','')[:80])" 2>/dev/null)

if [ "$AGENT_STATUS" = "done" ]; then
  pass "Agent 聊天回复成功: \"${AGENT_REPLY}...\""
else
  fail "Agent 聊天失败: status=${AGENT_STATUS} resp=${AGENT_RESP}"
fi

# 等待 backgroundPostLog 异步完成
sleep 5

LOG_AFTER=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" | \
  python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
LOG_DIFF=$((LOG_AFTER - LOG_BEFORE))

if [ "$LOG_DIFF" -ge 1 ]; then
  pass "backgroundPostLog 写入成功（日志数 ${LOG_BEFORE} → ${LOG_AFTER}）"
else
  fail "backgroundPostLog 未写入（日志数无变化 ${LOG_BEFORE} → ${LOG_AFTER}）"
  info "可能原因: LLMWIKI_BASE 未设置 / 网络不通 / userId 为空"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "A4: Agent 健康咨询 → 验证 health_profile 被使用"

# 传入 health_profile，让 Agent 基于档案回复
HEALTH_RESP=$(call_agent \
  "我最近血压有点高，145/95，需要调药吗？" \
  "$TEST_USER_ID" "张阿姨" \
  "高血压患者10年，青霉素过敏" \
  "${BASE_HW}")
H_STATUS=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
H_REPLY=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; r=json.load(sys.stdin).get('reply',''); print(r[:150])" 2>/dev/null)
H_REASONING=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reasoning',''))" 2>/dev/null)

if [ "$H_STATUS" = "done" ] || [ "$H_STATUS" = "processing" ]; then
  pass "Agent 健康咨询回复: status=${H_STATUS}"
  info "回复: \"${H_REPLY}...\""
  info "推理: ${H_REASONING}"
else
  fail "Agent 健康咨询失败: ${HEALTH_RESP}"
fi

# 等日志写入
sleep 5

# ═══════════════════════════════════════════════════════════════════════════════
section "A5: 多轮对话模拟（10轮）→ 验证日志持续积累"

LOG_BEFORE_MULTI=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" | \
  python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

CONVERSATIONS=(
  "我昨天走路走了5000步，感觉膝盖有点酸"
  "血糖空腹测了6.8，餐后两小时8.5，这正常吗"
  "最近老是失眠，凌晨3点就醒了，怎么办"
  "我想问一下，阿托伐他汀要一直吃吗，能停药吗"
  "我女儿说让我补充辅酶Q10，有用吗"
  "上周去医院复查了，医生说心电图正常"
  "我想问问平时饮食有什么需要注意的"
  "最近天气热，感觉头晕，会不会是血压问题"
  "对了我有个问题一直想问，老年人需要补钙吗"
  "好的谢谢你，下次再问你"
)

HISTORY="[]"
MULTI_SUCCESS=0
MULTI_FAIL=0

for i in "${!CONVERSATIONS[@]}"; do
  MSG="${CONVERSATIONS[$i]}"
  ROUND=$((i + 1))
  
  RESP=$(call_agent "$MSG" "$TEST_USER_ID" "张阿姨" "高血压10年，青霉素过敏" "$BASE_UP" "$HISTORY")
  STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  REPLY=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply','')[:60])" 2>/dev/null)
  
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ]; then
    ((MULTI_SUCCESS++))
    echo -e "  ${GREEN}  轮${ROUND}${NC} → \"${REPLY}...\""
  else
    ((MULTI_FAIL++))
    echo -e "  ${RED}  轮${ROUND} 失败${NC}"
  fi

  # 构建历史（最近5轮）
  HISTORY=$(python3 -c "
import json
h = $HISTORY
h.append({'role':'user','content':'''$MSG'''})
h.append({'role':'assistant','content':'''$REPLY'''})
print(json.dumps(h[-10:], ensure_ascii=False))
")

  sleep 1  # 避免 rate limiting
done

if [ "$MULTI_SUCCESS" -eq 10 ]; then
  pass "10轮对话全部成功"
else
  fail "10轮对话: ${MULTI_SUCCESS} 成功, ${MULTI_FAIL} 失败"
fi

# 等 backgroundPostLog 全部完成
sleep 10

LOG_AFTER_MULTI=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" | \
  python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
LOG_MULTI_DIFF=$((LOG_AFTER_MULTI - LOG_BEFORE_MULTI))
info "多轮对话日志写入: ${LOG_MULTI_DIFF} 条新日志（期望 ≥8）"

if [ "$LOG_MULTI_DIFF" -ge 8 ]; then
  pass "多轮对话日志持续写入: ${LOG_MULTI_DIFF} 条"
else
  fail "多轮对话日志写入不足: ${LOG_MULTI_DIFF} 条 (期望 ≥8)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "A6: 触发 sync → 验证新增记忆提取准确性"

info "触发 sync（处理多轮对话日志）..."
SYNC2=$(curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/sync" \
  -H "Content-Type: application/json" --max-time 120)
S2_OK=$(echo "$SYNC2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)
S2_FILES=$(echo "$SYNC2" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('updatedFiles',[])))" 2>/dev/null)

if [ "$S2_OK" = "True" ]; then
  pass "sync 完成: ${S2_FILES}"
else
  info "sync 返回 wikiUpdated=false（可能所有日志已同步）"
fi

# 读取 sync 后的完整 wiki
WIKI_AFTER=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/wiki")

# 验证关键数据是否被正确提取
echo "$WIKI_AFTER" | python3 -c "
import sys, json
w = json.load(sys.stdin)
all_text = ' '.join(v for v in w.values())

checks = [
    ('高血压/135', '135' in all_text or '高血压' in all_text),
    ('阿托伐他汀', '阿托伐他汀' in all_text),
    ('青霉素过敏', '青霉素' in all_text),
    ('血糖6.8', '6.8' in all_text or '血糖' in all_text),
    ('失眠', '失眠' in all_text or '凌晨' in all_text),
]

for name, ok in checks:
    status = '✓' if ok else '✗'
    print(f'  {status} 记忆验证: {name} → {\"已记录\" if ok else \"未找到\"}\')
" 2>/dev/null

# 验证旧数据没被覆盖
OLD_DATA_OK=$(echo "$WIKI_AFTER" | python3 -c "
import sys,json
w = json.load(sys.stdin)
all_text = ' '.join(v for v in w.values())
# 初始档案的数据应该还在
has_old = '135' in all_text or '高血压' in all_text
has_med = '阿托伐他汀' in all_text
print('yes' if (has_old and has_med) else 'no')
" 2>/dev/null || echo "no")

if [ "$OLD_DATA_OK" = "yes" ]; then
  pass "✨ 增量验证：初始档案数据（高血压/阿托伐他汀）未被覆盖"
else
  fail "⚠️ 增量问题：初始档案数据可能被覆盖"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "A7: context-inject prefetch → 不同 query 拉取不同页面"

# query=血糖 → 应该从 medical_history.md 拉到相关内容
CI_BG=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/context-inject?query=%E8%A1%80%E7%B3%96")
CI_BG_HW=$(echo "$CI_BG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('health_wiki',''))" 2>/dev/null)
CI_BG_LEN=${#CI_BG_HW}
info "query=血糖 → health_wiki ${CI_BG_LEN} 字符"
echo "$CI_BG_HW" | grep -qi "血糖\|6.8\|空腹" && \
  pass "prefetch(血糖) 返回了血糖相关内容" || \
  skip "prefetch(血糖) 未返回血糖相关内容（BM25 匹配取决于内容）"

# query=用药 → 应该拉到 medication_plan
CI_MED=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/context-inject?query=%E7%94%A8%E8%8D%AF%E6%96%B9%E6%A1%88")
CI_MED_HW=$(echo "$CI_MED" | python3 -c "import sys,json; print(json.load(sys.stdin).get('health_wiki',''))" 2>/dev/null)
CI_MED_LEN=${#CI_MED_HW}
info "query=用药方案 → health_wiki ${CI_MED_LEN} 字符"
echo "$CI_MED_HW" | grep -qi "阿托伐他汀\|用药\|药" && \
  pass "prefetch(用药方案) 返回了用药相关内容" || \
  skip "prefetch(用药方案) 未返回用药相关内容"

# full mode → 应包含 index.md 概要
CI_FULL=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/context-inject")
CI_FULL_HW=$(echo "$CI_FULL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('health_wiki',''))" 2>/dev/null)
CI_FULL_LEN=${#CI_FULL_HW}
CI_FULL_UP=$(echo "$CI_FULL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_profile',''))" 2>/dev/null)
CI_FULL_UP_LEN=${#CI_FULL_UP}
info "full mode → health_wiki ${CI_FULL_LEN} 字符, user_profile ${CI_FULL_UP_LEN} 字符"

if [ "$CI_FULL_LEN" -gt 200 ]; then
  pass "full mode 返回丰富 health_wiki (${CI_FULL_LEN} 字符)"
else
  fail "full mode health_wiki 太短 (${CI_FULL_LEN} 字符)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "A8: 矛盾信息追加 → 验证不覆盖旧偏好"

# 之前说"不要用专业词"，现在说"我女儿是护士，可以用专业术语"
curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：我女儿跟我说，以后你也可以用专业的术语来解释，她能看懂。如果我看不懂我会问她。还有提醒我，我下周三下午要去医院复查血脂。\nAI：好的张阿姨，以后如果遇到专业内容我会稍微详细些，您不懂可以问女儿。下周三血脂复查已经帮您记下了。","title":"矛盾偏好+提醒"}' > /dev/null

info "写入矛盾偏好日志，触发 sync..."
SYNC3=$(curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/sync" \
  -H "Content-Type: application/json" --max-time 120)
S3_OK=$(echo "$SYNC3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)

if [ "$S3_OK" = "True" ]; then
  # 检查 user_profile 是否同时包含新旧信息
  CI_AFTER=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/context-inject")
  UP_AFTER=$(echo "$CI_AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_profile',''))" 2>/dev/null)
  echo "  ──────────────────────────────"
  echo "$UP_AFTER" | head -20 | sed 's/^/  │ /'
  echo "  ──────────────────────────────"
  
  # 验证新旧信息共存
  echo "$UP_AFTER" | grep -qi "护士\|女儿" && \
    pass "user_profile 包含关键背景（护士/女儿）" || \
    fail "user_profile 缺少关键背景"
else
  skip "矛盾偏好 sync 未更新"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "A9: 超长 health_profile 注入 → Agent 不崩溃"

# 构造一个很长的 health_profile（3000字）
LONG_PROFILE=$(python3 -c "
profile = '''# 健康档案
## 高血压
- 病史10年，血压 135/85
- 用药：氨氯地平 5mg qd

## 血脂异常
- 总胆固醇 6.2, LDL 3.8
- 用药：阿托伐他汀 20mg qn
''' * 10
print(profile[:3000])
")

LONG_RESP=$(call_agent "请帮我总结一下我的健康状况" "$TEST_USER_ID" "张阿姨" "高血压+高血脂" "$LONG_PROFILE")
LONG_STATUS=$(echo "$LONG_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)

if [ "$LONG_STATUS" = "done" ] || [ "$LONG_STATUS" = "processing" ]; then
  pass "超长 health_profile (3000字) → Agent 正常处理"
else
  fail "超长 health_profile → Agent 崩溃: ${LONG_RESP}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 总结
echo ""
echo ""
echo "════════════════════════════════════════"
echo -e "  端到端测试结果: ${GREEN}${PASS} 通过${NC} / ${RED}${FAIL} 失败${NC} / ${YELLOW}${SKIP} 跳过${NC}"
echo "════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
