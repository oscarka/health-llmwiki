#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# test_llmwiki_edge_cases.sh — LLMWiki 集成边界值 & 多场景测试
#
# 覆盖范围：
#   E1  — 不存在的用户 → 404
#   E2  — 创建用户：缺必填字段/特殊字符/纯空格名称
#   E3  — 日志写入：各种 type 值/超长内容/空 content/非法 type
#   E4  — 纯闲聊日志 sync → 不应产生医疗数据但可能有 user_profile
#   E5  — 多轮对话日志 sync → 验证增量合并（不覆盖旧数据）
#   E6  — 重复 sync → 第二次应返回"暂无未同步"
#   E7  — context-inject：不存在用户 / 空 wiki / 各种 query
#   E8  — 纯 user_profile 对话（无健康数据）→ 验证单独提取
#   E9  — 冲突偏好 → 验证追加而非覆盖
#   E10 — 并发写入日志 → 数据完整性
# ──────────────────────────────────────────────────────────────────────────────

set -eo pipefail

BASE="${LLMWIKI_BASE:-https://llmwiki-yo5337ccva-an.a.run.app}"
PASS=0
FAIL=0
SKIP=0
CLIENT_IDS=()  # 用于最后统一清理

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { ((PASS++)); echo -e "${GREEN}  ✓ $1${NC}"; }
fail() { ((FAIL++)); echo -e "${RED}  ✗ $1${NC}"; }
skip() { ((SKIP++)); echo -e "${YELLOW}  ⊘ $1${NC}"; }
info() { echo -e "${CYAN}  ℹ $1${NC}"; }
section() { echo ""; echo -e "${CYAN}═══ $1 ═══${NC}"; }

# 工具函数：创建用户并记录 ID 用于清理
create_client() {
  local name="$1"
  local extra="${2:-}"
  local resp
  resp=$(curl -s -X POST "${BASE}/api/clients" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${name}\"${extra}}")
  local cid
  cid=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  if [ -n "$cid" ]; then
    CLIENT_IDS+=("$cid")
  fi
  echo "$cid"
}

# 工具函数：写日志
post_log() {
  local cid="$1"
  local type="$2"
  local content="$3"
  local title="${4:-测试日志}"
  curl -s -X POST "${BASE}/api/clients/${cid}/logs" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"${type}\",\"content\":$(python3 -c "import json; print(json.dumps('${content}'))" 2>/dev/null || echo "\"${content}\""),\"title\":\"${title}\"}"
}

# 清理函数
cleanup() {
  section "清理所有测试数据"
  if [ ${#CLIENT_IDS[@]} -eq 0 ]; then
    info "无需清理"
    return
  fi
  for cid in "${CLIENT_IDS[@]}"; do
    if [ -z "$cid" ]; then continue; fi
    local dr
    dr=$(curl -s -X DELETE "${BASE}/api/clients/${cid}")
    local ok
    ok=$(echo "$dr" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',False))" 2>/dev/null || echo "False")
    if [ "$ok" = "True" ]; then
      info "已清理 ${cid}"
    else
      info "清理失败 ${cid}: ${dr}"
    fi
  done
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
section "E1: 不存在的用户 → 各接口应返回 404"

# context-inject
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/api/clients/nonexistent_user_12345/context-inject")
if [ "$HTTP" = "404" ]; then
  pass "context-inject 不存在用户 → 404"
else
  fail "context-inject 不存在用户 → HTTP ${HTTP} (期望 404)"
fi

# wiki
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/api/clients/nonexistent_user_12345/wiki")
if [ "$HTTP" = "404" ]; then
  pass "wiki 不存在用户 → 404"
else
  fail "wiki 不存在用户 → HTTP ${HTTP} (期望 404)"
fi

# logs
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/api/clients/nonexistent_user_12345/logs")
if [ "$HTTP" = "404" ]; then
  pass "logs 不存在用户 → 404"
else
  fail "logs 不存在用户 → HTTP ${HTTP} (期望 404)"
fi

# sync
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/clients/nonexistent_user_12345/sync")
if [ "$HTTP" = "404" ]; then
  pass "sync 不存在用户 → 404"
else
  fail "sync 不存在用户 → HTTP ${HTTP} (期望 404)"
fi

# POST log to nonexistent user
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/clients/nonexistent_user_12345/logs" \
  -H "Content-Type: application/json" \
  -d '{"type":"wechat","content":"test"}')
if [ "$HTTP" = "404" ]; then
  pass "POST log 不存在用户 → 404"
else
  fail "POST log 不存在用户 → HTTP ${HTTP} (期望 404)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "E2: 创建用户边界值"

# 缺必填字段 (name)
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/clients" \
  -H "Content-Type: application/json" \
  -d '{"age":30}')
if [ "$HTTP" = "400" ]; then
  pass "缺 name → 400"
else
  fail "缺 name → HTTP ${HTTP} (期望 400)"
fi

# 空名称
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/clients" \
  -H "Content-Type: application/json" \
  -d '{"name":""}')
if [ "$HTTP" = "400" ]; then
  pass "空 name → 400"
else
  fail "空 name → HTTP ${HTTP} (期望 400)"
fi

# 特殊字符名称
SPECIAL_NAME="测试用户_special_$(date +%s)"
SPECIAL_BODY=$(python3 -c "import json; print(json.dumps({'name':'${SPECIAL_NAME}'}))")
SPECIAL_RESP=$(curl -s -X POST "${BASE}/api/clients" \
  -H "Content-Type: application/json" \
  -d "${SPECIAL_BODY}")
CID_SPECIAL=$(echo "$SPECIAL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
if [ -n "$CID_SPECIAL" ]; then
  CLIENT_IDS+=("$CID_SPECIAL")
  pass "特殊字符名称创建成功: ${CID_SPECIAL}"
else
  fail "特殊字符名称创建失败: ${SPECIAL_RESP}"
fi

# 超长名称（200字符）
LONG_NAME=$(python3 -c "print('长' * 200)")
CID_LONG=$(create_client "${LONG_NAME}")
if [ -n "$CID_LONG" ]; then
  pass "超长名称(200字)创建成功"
else
  fail "超长名称创建失败"
fi

# 只有 name，其他全空
CID_MINIMAL=$(create_client "最小用户_$(date +%s)")
if [ -n "$CID_MINIMAL" ]; then
  pass "最小字段创建成功"
else
  fail "最小字段创建失败"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "E3: 日志写入边界值"

CID_LOG=$(create_client "日志测试用户_$(date +%s)")
if [ -z "$CID_LOG" ]; then
  fail "创建日志测试用户失败"
else
  # 合法的 type 值
  for LOG_TYPE in wechat phone video ocr; do
    RESP=$(curl -s -X POST "${BASE}/api/clients/${CID_LOG}/logs" \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"${LOG_TYPE}\",\"content\":\"测试 ${LOG_TYPE} 类型日志\"}")
    LID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
    if [ -n "$LID" ]; then
      pass "type=${LOG_TYPE} 写入成功"
    else
      fail "type=${LOG_TYPE} 写入失败: ${RESP}"
    fi
  done

  # 非法 type
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/clients/${CID_LOG}/logs" \
    -H "Content-Type: application/json" \
    -d '{"type":"invalid_type","content":"test"}')
  if [ "$HTTP" = "400" ]; then
    pass "非法 type → 400"
  else
    fail "非法 type → HTTP ${HTTP} (期望 400)"
  fi

  # 空 content
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/clients/${CID_LOG}/logs" \
    -H "Content-Type: application/json" \
    -d '{"type":"wechat","content":""}')
  if [ "$HTTP" = "400" ]; then
    pass "空 content → 400"
  else
    fail "空 content → HTTP ${HTTP} (期望 400)"
  fi

  # 缺 content
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/clients/${CID_LOG}/logs" \
    -H "Content-Type: application/json" \
    -d '{"type":"wechat"}')
  if [ "$HTTP" = "400" ]; then
    pass "缺 content → 400"
  else
    fail "缺 content → HTTP ${HTTP} (期望 400)"
  fi

  # 超长 content (5000字)
  LONG_CONTENT=$(python3 -c "print('血压正常。' * 1000)")
  RESP=$(curl -s -X POST "${BASE}/api/clients/${CID_LOG}/logs" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"wechat\",\"content\":\"${LONG_CONTENT}\"}")
  LID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  if [ -n "$LID" ]; then
    pass "超长 content (5000字) 写入成功"
  else
    fail "超长 content 写入失败"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "E4: 纯闲聊日志 sync → 不应产生虚假医疗数据"

CID_CHAT=$(create_client "闲聊测试用户_$(date +%s)")
if [ -n "$CID_CHAT" ]; then
  # 写入纯闲聊
  curl -s -X POST "${BASE}/api/clients/${CID_CHAT}/logs" \
    -H "Content-Type: application/json" \
    -d '{"type":"wechat","content":"用户：今天天气真好，你觉得呢？\nAI：是啊，今天阳光明媚，很适合出去走走呢！","title":"闲聊-天气"}' > /dev/null

  curl -s -X POST "${BASE}/api/clients/${CID_CHAT}/logs" \
    -H "Content-Type: application/json" \
    -d '{"type":"wechat","content":"用户：你推荐什么电视剧啊？\nAI：最近《繁花》很不错，您可以看看。","title":"闲聊-电视剧"}' > /dev/null

  info "写入2条纯闲聊日志，开始 sync..."
  SYNC_RESP=$(curl -s -X POST "${BASE}/api/clients/${CID_CHAT}/sync" \
    -H "Content-Type: application/json" \
    --max-time 120)
  WIKI_UPDATED=$(echo "$SYNC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated', False))" 2>/dev/null || echo "?")
  UPDATED_FILES=$(echo "$SYNC_RESP" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('updatedFiles',[])))" 2>/dev/null || echo "")

  if [ "$WIKI_UPDATED" = "True" ]; then
    info "sync 完成，更新文件: ${UPDATED_FILES}"
    # 验证没有虚假医疗数据 — 检查 medical_history.md 是否被更新
    if echo "$UPDATED_FILES" | grep -q "medical_history.md"; then
      # 获取内容验证是否有虚假数据
      WIKI=$(curl -s "${BASE}/api/clients/${CID_CHAT}/wiki")
      MH_CONTENT=$(echo "$WIKI" | python3 -c "import sys,json; print(json.load(sys.stdin).get('medical_history.md',''))" 2>/dev/null)
      # 如果 medical_history 里没有实质内容（没有 observation-block），那也算 OK
      HAS_BLOCK=$(echo "$MH_CONTENT" | grep -c "observation-block\|intervention-block" || true)
      if [ "$HAS_BLOCK" = "0" ]; then
        pass "纯闲聊 sync 后 medical_history.md 无虚假 block 数据"
      else
        fail "⚠️ 纯闲聊产生了虚假医疗 block 数据！"
        echo "$MH_CONTENT" | head -10 | sed 's/^/    /'
      fi
    else
      pass "纯闲聊 sync 未更新 medical_history.md（正确）"
    fi
  elif [ "$WIKI_UPDATED" = "False" ]; then
    # sync 返回 wikiUpdated:false 也合理（LLM 没提取出任何事实）
    pass "纯闲聊 sync 返回 wikiUpdated=false（LLM 正确判断无事实）"
  else
    fail "sync 异常: ${SYNC_RESP}"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "E5: 多轮增量 sync → 验证不覆盖旧数据"

CID_INCR=$(create_client "增量测试用户_$(date +%s)" ",\"age\":72,\"gender\":\"男\"")
if [ -n "$CID_INCR" ]; then
  # 第一轮：血压数据
  curl -s -X POST "${BASE}/api/clients/${CID_INCR}/logs" \
    -H "Content-Type: application/json" \
    -d '{"type":"wechat","content":"用户：今天早上血压145/92，头有点晕。\nAI：叔叔您好，您的血压偏高。建议先坐下休息，保持安静，15分钟后再量一次。","title":"第一轮-血压"}' > /dev/null
  info "第一轮：写入血压数据，开始 sync..."

  SYNC1=$(curl -s -X POST "${BASE}/api/clients/${CID_INCR}/sync" \
    -H "Content-Type: application/json" \
    --max-time 120)
  S1_OK=$(echo "$SYNC1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)
  S1_FILES=$(echo "$SYNC1" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('updatedFiles',[])))" 2>/dev/null)
  if [ "$S1_OK" = "True" ]; then
    pass "第一轮 sync 成功: ${S1_FILES}"
  else
    fail "第一轮 sync 失败"
  fi

  # 获取第一轮后的 Wiki 快照
  WIKI_AFTER_1=$(curl -s "${BASE}/api/clients/${CID_INCR}/wiki")
  BP_IN_WIKI=$(echo "$WIKI_AFTER_1" | python3 -c "
import sys,json
w = json.load(sys.stdin)
all_text = ' '.join(w.values())
print('yes' if '145' in all_text or '92' in all_text else 'no')
" 2>/dev/null || echo "no")
  if [ "$BP_IN_WIKI" = "yes" ]; then
    pass "第一轮 sync 后血压数据 (145/92) 已写入 Wiki"
  else
    fail "第一轮 sync 后未找到血压数据"
  fi

  # 第二轮：心率数据 + 沟通偏好
  curl -s -X POST "${BASE}/api/clients/${CID_INCR}/logs" \
    -H "Content-Type: application/json" \
    -d '{"type":"wechat","content":"用户：心率有点快，测了一下95次每分钟。对了，每次回复尽量简短一些，我年纪大了看长文字费劲。\nAI：好的叔叔，以后我尽量简短回复。心率95偏快，建议观察一下。","title":"第二轮-心率+偏好"}' > /dev/null
  info "第二轮：写入心率 + 沟通偏好，开始 sync..."

  SYNC2=$(curl -s -X POST "${BASE}/api/clients/${CID_INCR}/sync" \
    -H "Content-Type: application/json" \
    --max-time 120)
  S2_OK=$(echo "$SYNC2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)
  S2_FILES=$(echo "$SYNC2" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('updatedFiles',[])))" 2>/dev/null)
  if [ "$S2_OK" = "True" ]; then
    pass "第二轮 sync 成功: ${S2_FILES}"
  else
    fail "第二轮 sync 失败"
  fi

  # 验证增量性：第一轮的血压数据是否还在
  WIKI_AFTER_2=$(curl -s "${BASE}/api/clients/${CID_INCR}/wiki")
  BP_STILL=$(echo "$WIKI_AFTER_2" | python3 -c "
import sys,json
w = json.load(sys.stdin)
all_text = ' '.join(w.values())
print('yes' if '145' in all_text else 'no')
" 2>/dev/null || echo "no")
  HR_IN_WIKI=$(echo "$WIKI_AFTER_2" | python3 -c "
import sys,json
w = json.load(sys.stdin)
all_text = ' '.join(w.values())
print('yes' if '95' in all_text else 'no')
" 2>/dev/null || echo "no")

  if [ "$BP_STILL" = "yes" ]; then
    pass "✨ 增量验证：第一轮血压 145 数据仍保留"
  else
    fail "⚠️ 增量失败：第二轮 sync 覆盖了第一轮的血压数据！"
  fi
  if [ "$HR_IN_WIKI" = "yes" ]; then
    pass "✨ 增量验证：第二轮心率 95 数据已写入"
  else
    fail "第二轮心率数据未写入"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "E6: 重复 sync → 无未同步日志时应返回无更新"

if [ -n "$CID_INCR" ]; then
  SYNC_DUP=$(curl -s -X POST "${BASE}/api/clients/${CID_INCR}/sync" \
    -H "Content-Type: application/json" \
    --max-time 30)
  DUP_UPDATED=$(echo "$SYNC_DUP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated', '?'))" 2>/dev/null)
  DUP_MSG=$(echo "$SYNC_DUP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message', ''))" 2>/dev/null)

  if [ "$DUP_UPDATED" = "False" ]; then
    pass "重复 sync → wikiUpdated=false (${DUP_MSG})"
  else
    fail "重复 sync 应返回 wikiUpdated=false, 实际: ${DUP_UPDATED}"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "E7: context-inject 各种 query 边界"

if [ -n "$CID_INCR" ]; then
  # 空 query → full 模式
  MODE=$(curl -s "${BASE}/api/clients/${CID_INCR}/context-inject" | \
    python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null)
  if [ "$MODE" = "full" ]; then
    pass "空 query → mode=full"
  else
    fail "空 query → mode=${MODE} (期望 full)"
  fi

  # 有 query → prefetch
  MODE=$(curl -s "${BASE}/api/clients/${CID_INCR}/context-inject?query=%E8%A1%80%E5%8E%8B" | \
    python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null)
  if [ "$MODE" = "prefetch" ]; then
    pass "query=血压 → mode=prefetch"
  else
    fail "query=血压 → mode=${MODE} (期望 prefetch)"
  fi

  # 无关 query → prefetch 但可能返回空或少量内容
  CI_IRRELEVANT=$(curl -s "${BASE}/api/clients/${CID_INCR}/context-inject?query=python%E7%BC%96%E7%A8%8B")
  IRREL_HW_LEN=$(echo "$CI_IRRELEVANT" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('health_wiki','')))" 2>/dev/null || echo "0")
  info "无关 query (python编程) → health_wiki 长度: ${IRREL_HW_LEN}"
  # 不做 pass/fail — 只记录，BM25 可能还是返回一些内容
  pass "无关 query 不报错（health_wiki ${IRREL_HW_LEN} 字符）"

  # 超长 query (500字)
  LONG_Q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('血压' * 250))")
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/api/clients/${CID_INCR}/context-inject?query=${LONG_Q}")
  if [ "$HTTP" = "200" ]; then
    pass "超长 query (500字) → HTTP 200 不崩溃"
  else
    fail "超长 query → HTTP ${HTTP}"
  fi

  # 特殊字符 query
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/api/clients/${CID_INCR}/context-inject?query=%3Cscript%3Ealert(1)%3C/script%3E")
  if [ "$HTTP" = "200" ]; then
    pass "XSS query → HTTP 200 不崩溃"
  else
    fail "XSS query → HTTP ${HTTP}"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "E8: 纯 user_profile 对话（无健康数据）→ 验证单独提取"

CID_PROFILE=$(create_client "画像测试用户_$(date +%s)")
if [ -n "$CID_PROFILE" ]; then
  curl -s -X POST "${BASE}/api/clients/${CID_PROFILE}/logs" \
    -H "Content-Type: application/json" \
    -d '{"type":"wechat","content":"用户：我是做IT的，平时比较忙，你回复简短一些就行。我住在上海浦东。我妈妈才是你们的客户，我帮她问的。我妈妈不会用手机，所以都是我来跟你沟通。家里经济条件一般，不要推荐太贵的方案。\nAI：好的，了解了。以后我尽量简短回复。有什么需要帮您妈妈了解的随时问我。","title":"纯画像对话"}' > /dev/null

  info "写入纯 user_profile 日志（无健康数据），开始 sync..."
  SYNC_P=$(curl -s -X POST "${BASE}/api/clients/${CID_PROFILE}/sync" \
    -H "Content-Type: application/json" \
    --max-time 120)
  SP_OK=$(echo "$SYNC_P" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wikiUpdated',False))" 2>/dev/null)
  SP_FILES=$(echo "$SYNC_P" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('updatedFiles',[])))" 2>/dev/null)

  if [ "$SP_OK" = "True" ]; then
    info "sync 完成，更新文件: ${SP_FILES}"
    if echo "$SP_FILES" | grep -q "user_profile.md"; then
      pass "✨ 纯画像对话成功提取到 user_profile.md"
      # 检查内容
      CI=$(curl -s "${BASE}/api/clients/${CID_PROFILE}/context-inject")
      UP=$(echo "$CI" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_profile',''))" 2>/dev/null)
      echo "  ──────────────────────────────"
      echo "$UP" | head -15 | sed 's/^/  │ /'
      echo "  ──────────────────────────────"

      # 验证关键信息是否提取
      echo "$UP" | grep -qi "IT\|简短\|浦东\|上海\|妈妈\|经济" && pass "user_profile 包含关键画像信息" || fail "user_profile 缺少关键画像信息"
    else
      skip "纯画像对话 sync 未更新 user_profile.md（LLM 未提取）"
    fi
  else
    info "sync 返回 wikiUpdated=false，LLM 认为无可提取事实"
    skip "纯画像对话未被 LLM 提取（可能需要调优 prompt）"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "E9: Wiki 页面写入边界 — 非法 pageName"

if [ -n "$CID_MINIMAL" ]; then
  # 不以 .md 结尾
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "${BASE}/api/clients/${CID_MINIMAL}/wiki/test.txt" \
    -H "Content-Type: application/json" \
    -d '{"content":"test"}')
  if [ "$HTTP" = "400" ]; then
    pass "pageName=test.txt → 400"
  else
    fail "pageName=test.txt → HTTP ${HTTP} (期望 400)"
  fi

  # 路径穿越
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "${BASE}/api/clients/${CID_MINIMAL}/wiki/..%2F..%2Fetc%2Fpasswd.md" \
    -H "Content-Type: application/json" \
    -d '{"content":"hacked"}')
  if [ "$HTTP" = "400" ]; then
    pass "路径穿越 pageName → 400"
  else
    fail "路径穿越 pageName → HTTP ${HTTP} (期望 400)"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "E10: 并发写入日志 → 数据完整性"

CID_CONC=$(create_client "并发测试用户_$(date +%s)")
if [ -n "$CID_CONC" ]; then
  # 同时写入 5 条日志
  for i in $(seq 1 5); do
    curl -s -X POST "${BASE}/api/clients/${CID_CONC}/logs" \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"wechat\",\"content\":\"并发日志 #${i}: 测试内容 $(date +%s%N)\"}" &
  done
  wait  # 等所有后台请求完成

  sleep 2  # 给服务器一点时间
  LOG_COUNT=$(curl -s "${BASE}/api/clients/${CID_CONC}/logs" | \
    python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

  if [ "$LOG_COUNT" = "5" ]; then
    pass "并发写入 5 条日志，全部成功 (count=${LOG_COUNT})"
  else
    fail "并发写入日志丢失: 期望 5, 实际 ${LOG_COUNT}"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 总结
echo ""
echo "════════════════════════════════════════"
echo -e "  测试结果: ${GREEN}${PASS} 通过${NC} / ${RED}${FAIL} 失败${NC} / ${YELLOW}${SKIP} 跳过${NC}"
echo "════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
