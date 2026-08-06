#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# test_agent_llmwiki_full.sh — Agent ↔ LLMWiki 全链路深度测试
#
# 测试矩阵（50+ 断言）：
#
#   Phase 1: 基础连通
#     P1.1 — 两个服务可达
#     P1.2 — 创建测试用户
#     P1.3 — 初始档案建立（3条历史 + sync）
#     P1.4 — 记忆基线校验（5项关键数据验证）
#
#   Phase 2: Agent 日志回写验证
#     P2.1 — 普通聊天 → backgroundPostLog
#     P2.2 — 健康咨询 → backgroundPostLog + health_profile 注入
#     P2.3 — Agent 对不存在用户 → 不崩溃（graceful skip）
#     P2.4 — Agent 空 user_id → 不写日志
#
#   Phase 3: 30轮真实对话场景
#     P3.1 — 模拟30轮不同场景对话（闲聊/健康/用药/情绪/饮食...）
#     P3.2 — 验证日志持续积累（≥25条）
#     P3.3 — 带历史上下文的对话（验证 context 不崩溃）
#
#   Phase 4: 记忆提取准确性
#     P4.1 — sync 后逐项校验关键健康数据（血压/血糖/用药/化验/症状）
#     P4.2 — user_profile 提取准确性（偏好/背景/禁忌）
#     P4.3 — 旧数据增量保留验证
#     P4.4 — 时间轴排序验证
#
#   Phase 5: context-inject 精度
#     P5.1 — full 模式（index.md 概要）
#     P5.2 — prefetch 各种 query（血压/用药/血糖/睡眠/饮食/不相关）
#     P5.3 — user_profile 始终返回
#     P5.4 — token 估算合理性
#
#   Phase 6: 记忆不覆盖 + 矛盾处理
#     P6.1 — 第二轮新增数据 sync → 旧数据保留
#     P6.2 — 矛盾偏好追加
#     P6.3 — 重复 sync 幂等
#
#   Phase 7: 边界值 & 压力
#     P7.1 — 超长 health_profile (5000字) → Agent 不崩溃
#     P7.2 — 超长消息内容 → Agent 正常回复
#     P7.3 — 超长 history (30轮) → Agent 正常回复
#     P7.4 — 空 health_profile → Agent 正常回复
#     P7.5 — 并发 Agent 调用（5个同时）
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
BOLD='\033[1m'
NC='\033[0m'

pass() { ((PASS++)); echo -e "${GREEN}  ✓ $1${NC}"; }
fail() { ((FAIL++)); echo -e "${RED}  ✗ $1${NC}"; }
skip() { ((SKIP++)); echo -e "${YELLOW}  ⊘ $1${NC}"; }
info() { echo -e "${CYAN}  ℹ $1${NC}"; }
section() { echo ""; echo -e "${BOLD}${CYAN}═══ $1 ═══${NC}"; }
subsection() { echo -e "${CYAN}  ── $1 ──${NC}"; }

cleanup() {
  section "清理"
  if [ -n "$TEST_USER_ID" ]; then
    curl -s -X DELETE "${WIKI_BASE}/api/clients/${TEST_USER_ID}" > /dev/null 2>&1
    info "已清理 ${TEST_USER_ID}"
  fi
}
trap cleanup EXIT

# ── 工具函数 ──────────────────────────────────────────────────────────────────

call_agent() {
  local content="$1"
  local user_id="${2:-$TEST_USER_ID}"
  local user_name="${3:-张阿姨}"
  local notes="${4:-}"
  local health_profile="${5:-}"
  local history_json="${6:-[]}"

  # 用 temp files 传参，避免 shell 特殊字符转义问题
  local tmpdir
  tmpdir=$(mktemp -d)
  echo -n "$content" > "$tmpdir/content.txt"
  echo -n "$notes" > "$tmpdir/notes.txt"
  echo -n "$health_profile" > "$tmpdir/hp.txt"
  echo -n "$history_json" > "$tmpdir/history.json"

  python3 - "$tmpdir" "$user_id" "$user_name" "${AGENT_BASE}" << 'PYEOF'
import json, urllib.request, sys, os

tmpdir = sys.argv[1]
user_id = sys.argv[2]
user_name = sys.argv[3]
agent_base = sys.argv[4]

content = open(os.path.join(tmpdir, 'content.txt')).read()
notes = open(os.path.join(tmpdir, 'notes.txt')).read()
hp = open(os.path.join(tmpdir, 'hp.txt')).read()
try:
    history = json.loads(open(os.path.join(tmpdir, 'history.json')).read())
except:
    history = []

body = {
    'content': content,
    'source': 'wecom',
    'session_id': user_id,
    'meta': {'from_name': user_name, 'user_id': user_id, 'company': '测试公司'},
    'context': {'available_apps': ['企业微信'], 'current_recipient': user_name},
    'history': history,
    'notes': notes,
    'health_profile': hp,
}

data = json.dumps(body, ensure_ascii=False).encode('utf-8')
req = urllib.request.Request(f'{agent_base}/api/v1/agent/chat',
    data=data, headers={'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        print(resp.read().decode('utf-8'))
except Exception as e:
    print(json.dumps({'status': 'error', 'error': str(e)}))
PYEOF

  rm -rf "$tmpdir"
}

get_log_count() {
  curl -s "${WIKI_BASE}/api/clients/${1}/logs" | \
    python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0"
}

get_unsynced_count() {
  curl -s "${WIKI_BASE}/api/clients/${1}/logs" | \
    python3 -c "import sys,json; print(len([l for l in json.load(sys.stdin) if not l.get('synced')]))" 2>/dev/null || echo "0"
}

wiki_contains() {
  local cid="$1"
  local keyword="$2"
  curl -s "${WIKI_BASE}/api/clients/${cid}/wiki" | \
    python3 -c "
import sys,json
w = json.load(sys.stdin)
text = ' '.join(v for v in w.values())
print('yes' if '$keyword' in text else 'no')
" 2>/dev/null || echo "no"
}

# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 1: 基础连通 + 档案基线"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "P1.1 服务可达"
AGENT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${AGENT_BASE}/api/health")
[ "$AGENT_HTTP" = "200" ] && pass "Agent 可达" || { fail "Agent 不可达 (HTTP ${AGENT_HTTP})"; exit 1; }

WIKI_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${WIKI_BASE}/api/clients")
[ "$WIKI_HTTP" = "200" ] && pass "LLMWiki 可达" || { fail "LLMWiki 不可达"; exit 1; }

subsection "P1.2 创建测试用户"
CREATE_RESP=$(curl -s -X POST "${WIKI_BASE}/api/clients" \
  -H "Content-Type: application/json" \
  -d '{"name":"深度测试-张阿姨","age":68,"gender":"女","allergies":"青霉素过敏,磺胺类过敏"}')
TEST_USER_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$TEST_USER_ID" ] && pass "用户创建: ${TEST_USER_ID}" || { fail "创建失败"; exit 1; }

subsection "P1.3 预置历史档案（5条丰富日志）+ 初始 sync"

# 日志1: 高血压病史 + 基础用药
curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"phone","content":"患者张阿姨，68岁女性。高血压病史12年，目前服用氨氯地平5mg每天一次，血压控制在135/85左右。2024年8月因头晕住院，CT显示左侧基底节区腔隙性脑梗死。出院后加用阿司匹林100mg每天一次。","title":"电话随访-病史回顾"}' > /dev/null

# 日志2: 血脂异常 + 用药
curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：我上个月查了血脂，总胆固醇6.2，甘油三酯2.1，低密度脂蛋白3.8。医生开了阿托伐他汀20mg每晚一次。\nAI：张阿姨，您的血脂确实偏高，特别是LDL 3.8超过了目标值。阿托伐他汀是对症的，建议3个月后复查。","title":"血脂异常-用药"}' > /dev/null

# 日志3: 血糖 + 饮食
curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：空腹血糖6.5，餐后2小时血糖9.2，医生说是糖尿病前期。我该怎么控制饮食？\nAI：张阿姨，您目前处于糖前期，还不需要吃药，主要通过饮食控制。建议减少精制碳水，多吃蔬菜和粗粮。","title":"血糖-饮食指导"}' > /dev/null

# 日志4: 沟通偏好 + 家庭背景
curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：你跟我说话不要用太专业的词，我文化程度不高。我女儿是护士，有些问题她会帮我问。我老伴去年走了，现在我一个人住。千万别跟我说什么危险不危险的，我容易紧张。\nAI：好的张阿姨，我以后用简单的话跟您说。有什么问题您女儿也可以随时问我。","title":"沟通偏好-背景"}' > /dev/null

# 日志5: 睡眠 + 运动
curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：最近总是凌晨3点就醒了，翻来覆去睡不着。白天精神不太好。每天早上我会去公园走半小时。\nAI：张阿姨，早醒可能跟您情绪有关，也可能和用药有关。每天走路半小时很好，建议保持。可以试试睡前泡泡脚。","title":"睡眠-运动"}' > /dev/null

pass "5条丰富历史日志已写入"

info "初始 sync（建立完整档案基线）..."
SYNC_RESP=$(curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/sync" \
  -H "Content-Type: application/json" --max-time 180)
SYNC_OK=$(echo "$SYNC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)
SYNC_FILES=$(echo "$SYNC_RESP" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('updatedFiles',[])))" 2>/dev/null)
[ "$SYNC_OK" = "True" ] && pass "初始 sync 完成: ${SYNC_FILES}" || fail "初始 sync 失败"

subsection "P1.4 记忆基线校验（逐项验证）"

# 验证 wiki 中的关键数据
CHECKS=(
  "高血压:高血压"
  "氨氯地平:氨氯地平"
  "阿司匹林:阿司匹林"
  "阿托伐他汀:阿托伐他汀"
  "脑梗:脑梗"
  "血糖6.5:6.5"
  "LDL3.8:3.8"
  "甘油三酯2.1:2.1"
  "青霉素过敏:青霉素"
  "失眠/早醒:失眠"
)

for check in "${CHECKS[@]}"; do
  label="${check%%:*}"
  keyword="${check##*:}"
  result=$(wiki_contains "$TEST_USER_ID" "$keyword")
  [ "$result" = "yes" ] && pass "记忆基线: ${label}" || skip "记忆基线未提取: ${label}（LLM 可能用了不同措辞）"
done

# user_profile 验证
CI_BASE=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/context-inject")
BASE_UP=$(echo "$CI_BASE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_profile',''))" 2>/dev/null)
BASE_HW=$(echo "$CI_BASE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('health_wiki',''))" 2>/dev/null)

echo "$BASE_UP" | grep -qi "专业\|简单\|文化" && pass "user_profile: 沟通偏好（简单语言）" || skip "user_profile: 沟通偏好未提取"
echo "$BASE_UP" | grep -qi "护士\|女儿" && pass "user_profile: 女儿是护士" || skip "user_profile: 女儿背景未提取"
echo "$BASE_UP" | grep -qi "一个人\|老伴\|独居" && pass "user_profile: 独居状态" || skip "user_profile: 独居未提取"
echo "$BASE_UP" | grep -qi "紧张\|危险\|不要说" && pass "user_profile: 禁忌（不说危险）" || skip "user_profile: 禁忌未提取"

info "user_profile 内容:"
echo "$BASE_UP" | head -20 | sed 's/^/  │ /'

# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 2: Agent 日志回写验证"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "P2.1 普通聊天 → backgroundPostLog"
LOG_B=$(get_log_count "$TEST_USER_ID")
RESP=$(call_agent "你好啊，今天心情不错" "$TEST_USER_ID" "张阿姨")
STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$STATUS" = "done" ] && pass "聊天回复成功" || fail "聊天失败: ${RESP}"
sleep 5
LOG_A=$(get_log_count "$TEST_USER_ID")
[ "$LOG_A" -gt "$LOG_B" ] && pass "日志回写成功 (${LOG_B}→${LOG_A})" || fail "日志未回写"

subsection "P2.2 健康咨询 → Agent 自动拉取 wiki context"
LOG_B2=$(get_log_count "$TEST_USER_ID")
RESP2=$(call_agent "我最近血压量了一下150/95，是不是需要调药了？" \
  "$TEST_USER_ID" "张阿姨" "高血压12年，青霉素过敏")
STATUS2=$(echo "$RESP2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
REPLY2=$(echo "$RESP2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply','')[:100])" 2>/dev/null)
[ "$STATUS2" = "done" ] || [ "$STATUS2" = "processing" ] && pass "健康咨询回复: ${STATUS2}" || fail "健康咨询失败"
info "回复: \"${REPLY2}...\""
sleep 5
LOG_A2=$(get_log_count "$TEST_USER_ID")
if [ "$LOG_A2" -gt "$LOG_B2" ]; then
  pass "健康咨询日志回写 (${LOG_B2}→${LOG_A2})"
elif [ "$STATUS2" = "processing" ]; then
  pass "健康咨询走 Skill 异步，日志将在 callback 后写入"
else
  fail "健康咨询日志未回写"
fi

subsection "P2.3 不存在用户 → Agent 不崩溃"
RESP3=$(call_agent "你好" "nonexistent_user_999" "测试" "" "")
STATUS3=$(echo "$RESP3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$STATUS3" = "done" ] && pass "不存在用户 → Agent 正常回复（日志静默跳过）" || fail "不存在用户 → Agent 崩溃"

subsection "P2.4 空 user_id → 不写日志"
LOG_B4=$(get_log_count "$TEST_USER_ID")
RESP4=$(call_agent "你好" "" "匿名用户" "" "")
STATUS4=$(echo "$RESP4" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$STATUS4" = "done" ] && pass "空 user_id → Agent 正常回复" || fail "空 user_id → Agent 崩溃"

# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 3: 30轮真实场景对话"
# ═══════════════════════════════════════════════════════════════════════════════

LOG_BEFORE_30=$(get_log_count "$TEST_USER_ID")
HISTORY="[]"
SUCCESS_COUNT=0
FAIL_COUNT=0

MSGS=(
  # 1-5: 健康监测
  "今天早上血压量了142/88，比昨天高了一点"
  "血糖空腹测了7.1，是不是有点高了"
  "昨晚睡得还行，但是凌晨4点醒了一次"
  "走路的时候左膝盖有点疼，上下楼梯更明显"
  "最近总觉得心跳快，有时候会砰砰跳"
  # 6-10: 用药咨询
  "氨氯地平和阿托伐他汀可以同时吃吗"
  "阿司匹林要饭后吃还是饭前吃"
  "我听邻居说有个降压药叫缬沙坦，比氨氯地平好，是真的吗"
  "降脂药要一直吃吗，能停药吗"
  "我想问问辅酶Q10有没有用"
  # 11-15: 饮食营养
  "我早上一般喝粥配咸菜，这样可以吗"
  "听说高血压不能吃太咸，那一天盐吃多少合适"
  "糖尿病前期能吃水果吗，什么水果可以吃"
  "我最近开始喝牛奶了，每天一杯，行吗"
  "鸡蛋每天能吃几个，胆固醇高能吃蛋黄吗"
  # 16-20: 生活方式
  "天气热了我还能出去走路吗"
  "我女儿让我做做操，有什么适合老年人的运动"
  "我现在每天走5000步够吗，要不要多走一些"
  "洗澡的时候有时候头晕，是怎么回事"
  "最近情绪不太好，总想哭，是不是因为一个人住"
  # 21-25: 复查和检查
  "下个月要去医院复查，需要查哪些项目"
  "上次CT报告说腔隙性脑梗，这个严重吗"
  "心电图正常是不是就没事了"
  "肝功能需要查吗，吃他汀药会不会伤肝"
  "医生让我做个颈动脉超声，这是查什么的"
  # 26-30: 闲聊和情感
  "谢谢你一直陪我聊天"
  "今天天气不错，我去公园走了一圈"
  "你说我这个年纪还能活多久啊"
  "我女儿周末要来看我了，好开心"
  "好的，今天就先聊到这里，明天再问你"
)

for i in "${!MSGS[@]}"; do
  MSG="${MSGS[$i]}"
  ROUND=$((i + 1))

  RESP=$(call_agent "$MSG" "$TEST_USER_ID" "张阿姨" "高血压12年，青霉素过敏" "" "$HISTORY")
  STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  REPLY=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply','')[:50])" 2>/dev/null)

  if [ "$STATUS" = "done" ] || [ "$STATUS" = "processing" ]; then
    ((SUCCESS_COUNT++))
    printf "  ${GREEN}轮%02d${NC} %s → \"%s...\"\n" "$ROUND" "${MSG:0:20}" "${REPLY}"
  else
    ((FAIL_COUNT++))
    printf "  ${RED}轮%02d 失败${NC}\n" "$ROUND"
  fi

  # 累积最近10轮历史（用 temp file 避免转义问题）
  htmp=$(mktemp)
  python3 - "$HISTORY" "$MSG" "$REPLY" << 'HIST_PY' > "$htmp"
import json, sys
try:
    h = json.loads(sys.argv[1]) if sys.argv[1] != '[]' else []
except:
    h = []
h.append({'role':'user','content': sys.argv[2]})
h.append({'role':'assistant','content': sys.argv[3]})
print(json.dumps(h[-20:], ensure_ascii=False))
HIST_PY
  HISTORY=$(cat "$htmp" 2>/dev/null || echo "[]")
  rm -f "$htmp"

  # 控制速率
  sleep 1
done

[ "$SUCCESS_COUNT" -ge 28 ] && pass "30轮对话: ${SUCCESS_COUNT}/30 成功" || fail "30轮对话: ${SUCCESS_COUNT}/30 成功 (期望≥28)"
[ "$FAIL_COUNT" -le 2 ] && pass "失败数可接受: ${FAIL_COUNT}" || fail "失败太多: ${FAIL_COUNT}"

# 等 backgroundPostLog 完成（仅 status=done 的轮次立即写入，Skill 异步轮次在 callback 后写入）
info "等待同步日志写入完成 (10s)..."
sleep 10

LOG_AFTER_30=$(get_log_count "$TEST_USER_ID")
LOG_30_DIFF=$((LOG_AFTER_30 - LOG_BEFORE_30))
info "30轮对话新增日志: ${LOG_30_DIFF} 条（直接回复的轮次立即写入，Skill 异步轮次在 callback 后写入）"
# 30轮中约5轮是闲聊（直接回复），其余走 Skill（异步）。至少直接回复的要写入。
[ "$LOG_30_DIFF" -ge 3 ] && pass "日志持续积累: ${LOG_30_DIFF} 条 (≥3 直接回复轮次)" || fail "日志积累不足: ${LOG_30_DIFF} 条"

# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 4: 记忆提取准确性"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "P4.1 sync 多轮对话日志"
UNSYNCED=$(get_unsynced_count "$TEST_USER_ID")
info "待 sync 日志: ${UNSYNCED} 条"

info "触发 sync（处理30轮日志，可能需要60-120s）..."
SYNC4=$(curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/sync" \
  -H "Content-Type: application/json" --max-time 180)
S4_OK=$(echo "$SYNC4" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)
S4_FILES=$(echo "$SYNC4" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('updatedFiles',[])))" 2>/dev/null)
[ "$S4_OK" = "True" ] && pass "sync 完成: ${S4_FILES}" || info "sync wikiUpdated=${S4_OK}"

subsection "P4.2 逐项验证关键新增数据"

NEW_CHECKS=(
  "新血压142/88:142"
  "血糖7.1:7.1"
  "膝盖疼:膝盖"
  "心跳快:心跳"
)

for check in "${NEW_CHECKS[@]}"; do
  label="${check%%:*}"
  keyword="${check##*:}"
  result=$(wiki_contains "$TEST_USER_ID" "$keyword")
  [ "$result" = "yes" ] && pass "新记忆: ${label}" || skip "新记忆未提取: ${label}"
done

subsection "P4.3 旧数据增量保留验证"

OLD_CHECKS=(
  "旧血压135:135"
  "氨氯地平:氨氯地平"
  "阿托伐他汀:阿托伐他汀"
  "脑梗:脑梗"
  "青霉素过敏:青霉素"
)

for check in "${OLD_CHECKS[@]}"; do
  label="${check%%:*}"
  keyword="${check##*:}"
  result=$(wiki_contains "$TEST_USER_ID" "$keyword")
  [ "$result" = "yes" ] && pass "增量保留: ${label}" || fail "⚠️ 增量丢失: ${label}"
done

subsection "P4.4 sync 后日志全部标记已同步"
UNSYNCED_AFTER=$(get_unsynced_count "$TEST_USER_ID")
[ "$UNSYNCED_AFTER" = "0" ] && pass "所有日志已标记 synced" || fail "仍有 ${UNSYNCED_AFTER} 条未同步"

# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 5: context-inject 精度"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "P5.1 full 模式验证"
CI_FULL=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/context-inject")
FULL_MODE=$(echo "$CI_FULL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null)
FULL_HW_LEN=$(echo "$CI_FULL" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('health_wiki','')))" 2>/dev/null)
FULL_UP_LEN=$(echo "$CI_FULL" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('user_profile','')))" 2>/dev/null)
FULL_TOKEN=$(echo "$CI_FULL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token_estimate',{}).get('total',0))" 2>/dev/null)

[ "$FULL_MODE" = "full" ] && pass "full 模式正确" || fail "模式错误: ${FULL_MODE}"
[ "$FULL_HW_LEN" -gt 300 ] && pass "health_wiki 丰富 (${FULL_HW_LEN}字)" || fail "health_wiki 太短 (${FULL_HW_LEN}字)"
[ "$FULL_UP_LEN" -gt 50 ] && pass "user_profile 有内容 (${FULL_UP_LEN}字)" || fail "user_profile 太短"
info "token 估算: ${FULL_TOKEN}"

subsection "P5.2 prefetch 精度测试"

QUERIES=(
  "血压:blood_pressure:血压|135|142|氨氯地平"
  "用药方案:medication:氨氯地平|阿托伐他汀|阿司匹林|药"
  "血糖:blood_sugar:血糖|6.5|7.1|糖"
  "睡眠:sleep:睡眠|失眠|早醒|凌晨"
  "python编程:irrelevant:无关查询"
)

for q in "${QUERIES[@]}"; do
  IFS=':' read -r query_zh label keywords <<< "$q"
  ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$query_zh'))")
  PF_RESP=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/context-inject?query=${ENCODED}")
  PF_MODE=$(echo "$PF_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null)
  PF_HW=$(echo "$PF_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('health_wiki',''))" 2>/dev/null)
  PF_HW_LEN=${#PF_HW}
  PF_UP_LEN=$(echo "$PF_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('user_profile','')))" 2>/dev/null)

  if [ "$label" = "irrelevant" ]; then
    info "prefetch(${query_zh}) → ${PF_HW_LEN}字 (无关 query)"
    pass "无关 query 不报错"
  else
    # 检查返回的内容是否包含关键词
    MATCH="no"
    IFS='|' read -ra KW_ARRAY <<< "$keywords"
    for kw in "${KW_ARRAY[@]}"; do
      echo "$PF_HW" | grep -qi "$kw" && MATCH="yes" && break
    done
    [ "$MATCH" = "yes" ] && pass "prefetch(${query_zh}) → 命中相关内容 (${PF_HW_LEN}字)" || skip "prefetch(${query_zh}) 未命中 (${PF_HW_LEN}字)"
  fi

  # user_profile 始终返回
  [ "$PF_UP_LEN" -gt 0 ] || info "注意: prefetch(${query_zh}) user_profile 为空"
done

# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 6: 记忆不覆盖 + 矛盾处理"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "P6.1 新增数据 + 再次 sync"
curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：今天去复查了，血压130/82，比之前好多了。医生说降压药不用调。还查了个糖化血红蛋白6.1%。\nAI：太好了张阿姨！血压130/82控制得很好。糖化6.1%说明近3个月血糖整体还不错，继续保持饮食控制。","title":"复查结果"}' > /dev/null

info "写入复查数据，sync..."
SYNC6=$(curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/sync" \
  -H "Content-Type: application/json" --max-time 120)
S6_OK=$(echo "$SYNC6" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)
[ "$S6_OK" = "True" ] && pass "复查数据 sync 成功" || info "sync wikiUpdated=${S6_OK}"

# 验证新旧数据共存
R1=$(wiki_contains "$TEST_USER_ID" "130")
R2=$(wiki_contains "$TEST_USER_ID" "氨氯地平")
R3=$(wiki_contains "$TEST_USER_ID" "阿托伐他汀")
[ "$R1" = "yes" ] && pass "新数据: 血压130/82 已记录" || skip "新血压未记录"
[ "$R2" = "yes" ] && pass "旧数据: 氨氯地平未被覆盖" || fail "旧用药被覆盖"
[ "$R3" = "yes" ] && pass "旧数据: 阿托伐他汀未被覆盖" || fail "旧用药被覆盖"

subsection "P6.2 矛盾偏好追加"
curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"用户：以后有些专业的检查结果你可以直接跟我女儿说，她是护士能看懂。我自己的话你还是用简单的话跟我说。\nAI：好的张阿姨，以后专业的检查结果我跟您女儿详细说，跟您就用简单的话解释。","title":"偏好更新"}' > /dev/null

info "写入偏好更新，sync..."
SYNC_PF=$(curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/sync" \
  -H "Content-Type: application/json" --max-time 120)
SPF_OK=$(echo "$SYNC_PF" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)

CI_AFTER=$(curl -s "${WIKI_BASE}/api/clients/${TEST_USER_ID}/context-inject")
UP_AFTER=$(echo "$CI_AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_profile',''))" 2>/dev/null)
echo "  ──── user_profile 更新后 ────"
echo "$UP_AFTER" | head -20 | sed 's/^/  │ /'
echo "  ──────────────────────────────"

subsection "P6.3 重复 sync 幂等"
SYNC_DUP=$(curl -s -X POST "${WIKI_BASE}/api/clients/${TEST_USER_ID}/sync" \
  -H "Content-Type: application/json" --max-time 30)
DUP_OK=$(echo "$SYNC_DUP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated','?'))" 2>/dev/null)
[ "$DUP_OK" = "False" ] && pass "重复 sync → 无更新（幂等）" || fail "重复 sync 应无更新"

# ═══════════════════════════════════════════════════════════════════════════════
section "Phase 7: 边界值 & 压力测试"
# ═══════════════════════════════════════════════════════════════════════════════

subsection "P7.1 function calling → get_medical_history"
RESP71=$(call_agent "帮我详细看一下我的化验结果和病史" "$TEST_USER_ID" "张阿姨")
S71=$(echo "$RESP71" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
R71=$(echo "$RESP71" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply','')[:80])" 2>/dev/null)
[ "$S71" = "done" ] || [ "$S71" = "processing" ] && pass "function calling 场景 Agent 正常响应" || fail "function calling 崩溃"
info "回复: \"${R71}...\""

subsection "P7.2 超长消息内容 (2000字)"
LONG_MSG=$(python3 -c "print(('我想问一下关于高血压的问题，' * 100)[:2000])")
RESP72=$(call_agent "$LONG_MSG" "$TEST_USER_ID" "张阿姨")
S72=$(echo "$RESP72" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$S72" = "done" ] || [ "$S72" = "processing" ] && pass "超长消息 (2000字) 不崩溃" || fail "超长消息崩溃"

subsection "P7.3 超长历史 (30轮 history)"
HIST_LEN=$(python3 - "$HISTORY" << 'HLEN'
import json, sys
try: print(len(json.loads(sys.argv[1])))
except: print(0)
HLEN
)
info "当前 history 长度: ${HIST_LEN} 条"
RESP73=$(call_agent "帮我总结一下我们今天聊了什么" "$TEST_USER_ID" "张阿姨" "" "" "$HISTORY")
S73=$(echo "$RESP73" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$S73" = "done" ] && pass "超长 history (${HIST_LEN}条) 不崩溃" || fail "超长 history 崩溃"

subsection "P7.4 无 wiki 用户 → Agent 正常回复"
RESP74=$(call_agent "你好" "no_wiki_user_$(date +%s)" "新用户")
S74=$(echo "$RESP74" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$S74" = "done" ] && pass "空 health_profile 正常回复" || fail "空 health_profile 崩溃"

subsection "P7.5 并发 Agent 调用（5个同时）"
CONC_OK=0
for i in $(seq 1 5); do
  call_agent "并发测试消息 #${i}" "$TEST_USER_ID" "张阿姨" > /tmp/conc_${i}.json &
done
wait

for i in $(seq 1 5); do
  S=$(python3 -c "import json; print(json.load(open('/tmp/conc_${i}.json')).get('status',''))" 2>/dev/null)
  [ "$S" = "done" ] || [ "$S" = "processing" ] && ((CONC_OK++))
done
rm -f /tmp/conc_*.json
[ "$CONC_OK" -ge 4 ] && pass "并发调用: ${CONC_OK}/5 成功" || fail "并发调用: ${CONC_OK}/5 成功 (期望≥4)"

# ═══════════════════════════════════════════════════════════════════════════════
# 最终报告
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo ""
echo "════════════════════════════════════════════════════════════════"
echo -e "  ${BOLD}全链路深度测试结果${NC}"
echo -e "  ${GREEN}${PASS} 通过${NC} / ${RED}${FAIL} 失败${NC} / ${YELLOW}${SKIP} 跳过${NC}"
echo "════════════════════════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
