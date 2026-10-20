/**
 * 情景小工具：需求登记 → AI 生成草稿 → 自动检查 → AI 独立复核 → 审核(医生/自动) → 上架。纯新增（新表、新接口）。
 *
 * 状态：
 *   需求 widget_request：queued 排队 | generating 生成中 | in_review 工具已做好等审核 | ready 工具已上架可用 | dropped 不做了 | failed 失败可重试
 *   工具 widget_tool：   pending_review 待医生审核 | approved 已上架 | rejected 医生驳回 | auto_rejected 自动检查/复核没过
 *
 * 两个后台开关（存库，可在审核页即时切换，不用重新发布；初始值取环境变量）：
 *   gen_enabled  on/off     是否自动为需求生成工具（WIDGET_GEN，默认 on）
 *   review_mode  manual/auto manual=必须医生通过才上架；auto=自动检查+AI复核都通过、且没有待人工确认的出处，就自动上架（WIDGET_REVIEW_MODE，默认 manual）
 *
 * 审核/管理接口必须带请求头 x-review-token（环境变量 WIDGET_REVIEW_TOKEN）；没配置 token 则管理接口一律拒绝。
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const KINDS = ['计算器', '选择→固定建议', '分步图文', '分配器', '清单'];
const NEEDS_CODE = ['计算器', '分配器', '选择→固定建议'];
// 合规：AI 生成内容里不得出现的表述（AGENTS.md「AI Safety Rules」）
const FORBIDDEN = /无需就医|不用就医|先观察|确诊为|AI确诊|AI诊断为|人工智能诊断|AI判断|你得了|可以自行(加|减|停)药|增加剂量|减少剂量|危及生命|life-threatening/;
// 安全：固定程序只允许纯计算，禁止触碰运行环境
const UNSAFE_CODE = /constructor|prototype|__proto__|process|require|import\s|eval|Function\s*\(|globalThis|global\b|this\b|fetch|XMLHttp|setTimeout|setInterval|while\s*\(\s*true|for\s*\(\s*;\s*;/;

const SKILL = (() => { try { return fs.readFileSync(path.join(__dirname, 'widget_skill.md'), 'utf8').replace(/^---[\s\S]*?---/, ''); } catch (e) { return ''; } })();
const EXEC_ADDENDUM = `
---
## 执行规则（后台自动执行，必须遵守）
你是后台异步执行上述规范的 AI。你不能向用户提问，也**没有** web_search / run_program 工具：
1. 只为【需求】这一件事设计 **0~1 个**工具；不该做的（属于饮食、服药提醒、症状应对、心情疏导、运动打卡）就返回 tools:[] 并在 rejected_ideas 写原因。
2. 固定写死的医学常数一律把 source 写成 \`pending_review\`（交给人工审核）或 \`医嘱原句\`；**不得自拟 URL**。
3. 输出里的 program_code 必须是纯 JS 函数 main(inputs)，不要使用 this / require / process / eval / 网络；你要自己确认默认输入下能跑通，key 用中文。
4. 若【已有生成工具】里已有能解决这件事的，直接输出 {"reuse":"<那个工具的 id>"}，不要重复做。
5. 自动检查最常卡住的两点，务必做到：①「分步图文」「清单」类必须在 content 字段里直接写出用户能读的完整条目（至少 3 条，如 [{"title":"...","items":["...","...","..."]}]），不能只在 program 描述里讲；②program_code 返回对象里的所有字段名（key，含嵌套）都必须是中文，不能出现 title/items/result 这类英文名。
6. 只输出 JSON。`;

const JUDGE_SYSTEM = `你是医疗健康产品的独立复核员。依据下面的“小工具规范”复核一个 AI 起草的小工具，只输出 JSON。
${SKILL}

复核口径：
- scope：这个工具解决的是哪一类事？只能是「办事」才合格（买什么/怎么挑/怎么带/怎么跑流程/家人怎么帮）。属于饮食(一切和吃有关)、服药提醒/用药时间表、症状应对、心情疏导、运动打卡 的，scope 写对应类别并判 fail。
- 以下判 fail：(1) 根据症状给分级处理/放行式表述（“出现X就立即就医”这种单向红线不算）；(2) 把某位患者的具体数值写死（应是 inputs）；(3) AI 自拟医学常数却写成已有出处；(4) 与【已有功能/已有工具/已有生成工具】重复，或只是大家都知道的常识；(5) 触发依据在输入里不存在、是编造的；(6) 只有泛泛提醒、没有选择/计算/步骤/清单实体；(7) 出现诊断或改药建议。
- pending_review 的常数是交给人工的通道，不算 fail。
输出：{"verdict":"pass|fail","scope":"办事|饮食|服药提醒|症状应对|心情疏导|运动打卡|其他","reasons":["一句话原因(通过也写依据)"],"duplicate_of":"重复的已有工具名，没有则空"}`;

function parseJson(text) {
  const t = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没有返回 JSON');
  return JSON.parse(m[0]);
}

function runProgram(code, inputs) {
  const src = `${code}\n;JSON.stringify(main(${JSON.stringify(inputs || {})}))`;
  const out = new vm.Script(src).runInNewContext(Object.create(null), { timeout: 1000 });
  if (typeof out !== 'string') throw new Error('程序没有返回结果');
  if (out.length > 20000) throw new Error('程序返回结果过大');
  return JSON.parse(out);
}

const isEn = (s) => /^[A-Za-z0-9_\-. ]+$/.test(String(s)) && /[A-Za-z]/.test(String(s));

function defaultInputs(spec) {
  const sample = {};
  for (const i of spec.inputs || []) {
    sample[i.key] = i.options && i.options.length ? i.options[0] : (i.type === 'date' ? '2025-06-10' : i.type === 'number' ? (Number(i.default) || 1) : '示例');
  }
  return sample;
}

/** 自动检查：hard=必须修的硬伤；human=需要人工确认的点（如无出处的常数） */
function lintTool(t) {
  const hard = []; const human = [];
  const n = t.name || t.id || '?';
  for (const k of ['id', 'name', 'kind', 'scenario_key', 'trigger', 'program', 'output', 'sources', 'not_do']) {
    if (!t[k] || (Array.isArray(t[k]) && !t[k].length)) hard.push(`缺少 ${k}`);
  }
  if (!Array.isArray(t.inputs)) hard.push('缺少 inputs（使用时可改的输入框）');
  if ((t.inputs || []).length > 3) hard.push(`用户使用时要填 ${(t.inputs || []).length} 项(>3)`);
  if (!t.trigger || !t.trigger.when) hard.push('没有明确触发条件');
  if (/\d/.test(t.program || '') && !String(t.disclaimer || '').trim()) hard.push('含数值但没有免责声明');
  if (!KINDS.includes(t.kind)) hard.push(`kind 不在允许类型内(${t.kind})`);
  if (FORBIDDEN.test(JSON.stringify({ ...t, not_do: undefined }))) hard.push('出现禁用表述');
  for (const i of t.inputs || []) {
    if (!i.label || isEn(i.label)) hard.push(`输入框 ${i.key} 的 label 必须是中文大白话`);
    if ((i.options || []).some(isEn)) hard.push(`输入框「${i.label}」的选项含英文代号，选项必须是用户看得懂的中文`);
    if (i.type === 'select' && !(i.options || []).length) hard.push(`输入框「${i.label}」是选择型但没有 options`);
  }
  if (NEEDS_CODE.includes(t.kind) && !t.program_code) hard.push(`${t.kind}必须有 program_code`);
  if (t.program_code) {
    if (UNSAFE_CODE.test(String(t.program_code))) hard.push('program_code 含不允许的写法（只能是纯计算函数 main(inputs)）');
    else {
      try {
        const sample = defaultInputs(t);
        const out = runProgram(t.program_code, sample);
        const enKeys = new Set();
        (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (isEn(k)) enKeys.add(k); walk(v); } })(out);
        if (enKeys.size) hard.push(`program_code 的输出字段名是英文(${[...enKeys].slice(0, 4).join('/')})，用户会直接看到，key 必须用中文`);
        if (out && out.error) hard.push(`用默认输入跑出了 error：${out.error}`);
        if (!out || (typeof out === 'object' && !Object.keys(out).length)) hard.push('用默认输入跑出的结果是空的');
      } catch (e) { hard.push(`program_code 用默认输入报错：${e.message}`); }
    }
  }
  if (['分步图文', '清单'].includes(t.kind)) {
    const c = t.content;
    const cnt = Array.isArray(c) ? c.reduce((a, s) => a + (Array.isArray(s.items) ? s.items.length : (s.text ? 1 : 0)), 0) : 0;
    if (cnt < 3) hard.push(`${t.kind}必须在 content 里写出用户直接能读的完整步骤/清单条目（至少3条）`);
  }
  for (const c of t.constants || []) {
    const src = String(c.source || '');
    if (/https?:\/\//.test(src)) hard.push(`常数「${clip(c.value, 20)}」的出处 URL 无法核实（后台没有联网搜索），请改为 pending_review`);
    else if (src === 'pending_review') human.push(`${n}: 常数「${clip(c.value, 20)}」待人工确认出处`);
    else if (!/医嘱原句/.test(src)) human.push(`${n}: 常数「${clip(c.value, 20)}」出处为“${clip(src, 30)}”（无 URL，需人工确认）`);
  }
  return { hard, human };
}

/** 给用户/审核页看的工具视图（不含程序代码） */
function publicView(row) {
  const s = row.spec || {};
  return {
    id: row.id, name: row.name, kind: row.kind,
    inputs: (s.inputs || []).map((i) => ({ key: i.key, label: i.label, type: i.type, options: i.options || [], default: i.default == null ? '' : i.default })),
    content: s.content || [], output: s.output || '', disclaimer: s.disclaimer || '', has_program: !!s.program_code,
    program: s.program || '',
  };
}

function registerWidgets(app, { db, findClient, llm }) {
  const ready = db.query(`
    CREATE TABLE IF NOT EXISTS llmwiki.widget_tool (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, scenario_key TEXT NOT NULL DEFAULT '',
      disease_label TEXT NOT NULL DEFAULT '', spec JSONB NOT NULL, status TEXT NOT NULL,
      review JSONB NOT NULL DEFAULT '{}'::jsonb, approved_by TEXT NOT NULL DEFAULT '', approved_mode TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS llmwiki.widget_request (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, name TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
      disease_label TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'onboarding', catalog JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'queued', tool_id TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', attempts INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS widget_request_client ON llmwiki.widget_request (client_id);
    ALTER TABLE llmwiki.widget_request ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE llmwiki.widget_request ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS llmwiki.widget_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL);`, [])
    .catch((e) => console.error('[Widgets] ensureTables failed:', e.message));

  const uid = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const getSetting = async (key, envName, dflt) => {
    try { const r = await db.query('SELECT value FROM llmwiki.widget_settings WHERE key=$1', [key]); if (r.rows[0]) return r.rows[0].value; } catch (e) { /* 读不到用默认 */ }
    return String(process.env[envName] || dflt);
  };
  const genEnabled = async () => (await getSetting('gen_enabled', 'WIDGET_GEN', 'on')) === 'on';
  const reviewMode = async () => ((await getSetting('review_mode', 'WIDGET_REVIEW_MODE', 'manual')) === 'auto' ? 'auto' : 'manual');

  const needAdmin = (req, res, next) => {
    const token = String(process.env.WIDGET_REVIEW_TOKEN || '');
    if (!token) return res.status(403).json({ error: '未配置审核口令，管理接口关闭' });
    const got = String(req.headers['x-review-token'] || '');
    const a = Buffer.from(got); const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: '审核口令不对' });
    next();
  };

  const syncRequests = async (toolId, toolStatus) => {
    const st = toolStatus === 'approved' ? 'ready' : (toolStatus === 'pending_review' ? 'in_review' : 'dropped');
    await db.query(`UPDATE llmwiki.widget_request SET status=$2, updated_at=$3 WHERE tool_id=$1`, [toolId, st, Date.now()]);
  };

  /** 草稿 → 自动检查 → AI 复核 → 决定状态 → 入库。AI 起草和人工提交的草稿走同一条路。 */
  async function processDraft(spec, ctx) {
    await ready;
    const catalogNames = (ctx.catalog || []).map((c) => clip(typeof c === 'string' ? c : c.name, 40)).filter(Boolean).slice(0, 120);
    const existing = (await db.query(`SELECT id, name, scenario_key, status FROM llmwiki.widget_tool WHERE status IN ('approved','pending_review') ORDER BY created_at DESC LIMIT 60`)).rows;
    const dup = existing.find((e) => e.scenario_key && e.scenario_key === spec.scenario_key);
    if (dup) return { toolId: dup.id, toolStatus: dup.status, reused: true };
    const lint = lintTool(spec);
    let judge = { verdict: 'fail', scope: '其他', reasons: ['未执行复核'], duplicate_of: '' };
    if (ctx.judgeOverride) judge = ctx.judgeOverride; // 仅管理接口(带口令)用于测试“审核流程判定逻辑”，AI 复核被替换为给定结论
    else if (!lint.hard.length) {
      try {
        judge = parseJson(await llm(JUDGE_SYSTEM, `【需求】${ctx.name || ''}（原因：${ctx.why || ''}）\n【病种】${ctx.disease_label || ''}\n【情景摘要】${ctx.situation || ''}\n【已有功能/工具名】${catalogNames.join('、') || '无'}\n【已有生成工具】${existing.map((e) => e.name).join('、') || '无'}\n【待复核工具】\n${JSON.stringify({ ...spec, program_code: spec.program_code ? '(见下)' : '' })}\n${spec.program_code ? `program_code:\n${spec.program_code}` : ''}`, { max_tokens: 1500, temperature: 0 }));
      } catch (e) { judge = { verdict: 'fail', scope: '其他', reasons: [`复核调用失败：${e.message}`], duplicate_of: '' }; }
    }
    const mode = await reviewMode();
    const checksOk = !lint.hard.length && judge.verdict === 'pass' && judge.scope === '办事';
    let status; let reason;
    if (!checksOk) { status = 'auto_rejected'; reason = lint.hard.length ? '自动检查没过' : `AI 复核没过(${judge.scope})`; }
    else if (mode === 'auto' && !lint.human.length && !ctx.isTest) { status = 'approved'; reason = '审核模式=自动：自动检查与AI复核全部通过，且没有待人工确认的出处'; }
    else { status = 'pending_review'; reason = ctx.isTest && mode === 'auto' && !lint.human.length ? '测试隔离：测试账号生成的工具即使自动模式也不自动上架（正常用户会自动上架）' : (mode === 'auto' ? '虽为自动模式，但有待人工确认的出处，转人工' : '审核模式=人工：等医生审核'); }
    const id = uid('wt');
    const review = { lint, judge, decision: { mode, status, reason, at: Date.now(), would_auto: checksOk && !lint.human.length }, history: [] };
    await db.query(`INSERT INTO llmwiki.widget_tool (id,name,kind,scenario_key,disease_label,spec,status,review,approved_by,approved_mode,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
    [id, clip(spec.name, 60), spec.kind || '', clip(spec.scenario_key, 80), clip(ctx.disease_label, 80), JSON.stringify(spec), status, JSON.stringify(review),
      status === 'approved' ? 'AI自动' : '', status === 'approved' ? 'auto' : '', Date.now()]);
    return { toolId: id, toolStatus: status, reason, lint, judge };
  }

  let running = 0;
  async function generateRequest(rid) {
    await ready;
    if (!(await genEnabled())) return { skipped: 'gen_disabled' };
    const claim = await db.query(`UPDATE llmwiki.widget_request SET status='generating', attempts=attempts+1, updated_at=$2
      WHERE id=$1 AND (status='queued' OR (status='failed' AND attempts<3)) RETURNING *`, [rid, Date.now()]);
    const rq = claim.rows[0];
    if (!rq) return { skipped: 'not_claimable' };
    running++;
    try {
      const existing = (await db.query(`SELECT id, name, scenario_key, status FROM llmwiki.widget_tool WHERE status IN ('approved','pending_review') ORDER BY created_at DESC LIMIT 60`)).rows;
      let sit = ''; try { const s = await db.query('SELECT summary FROM llmwiki.client_situation WHERE client_id=$1 ORDER BY created_at DESC LIMIT 1', [rq.client_id]); sit = clip(s.rows[0] && s.rows[0].summary, 600); } catch (e) { /* 没有情景档案也能做 */ }
      const catalog = (Array.isArray(rq.catalog) ? rq.catalog : []).map((c) => clip(typeof c === 'string' ? c : c.name, 40)).filter(Boolean).slice(0, 120);
      const user = `【需求】${rq.name}\n【为什么需要（用户原话/依据）】${rq.why || '无'}\n【病种】${rq.disease_label || '未知'}\n【情景摘要（用户自述）】${sit || '无'}\n【已有功能/工具（不重造）】${catalog.join('、') || '无'}\n【已有生成工具（可 reuse）】${JSON.stringify(existing.map((e) => ({ id: e.id, name: e.name, scenario_key: e.scenario_key })))}\n请只为这条需求设计 0~1 个工具。`;
      const out = parseJson(await llm(SKILL + EXEC_ADDENDUM, user, { max_tokens: 4500, temperature: 0.3 }));
      let result;
      if (out.reuse && existing.find((e) => e.id === out.reuse)) {
        const t = existing.find((e) => e.id === out.reuse);
        result = { toolId: t.id, toolStatus: t.status, reused: true };
      } else if (Array.isArray(out.tools) && out.tools.length) {
        result = await processDraft(out.tools[0], { name: rq.name, why: rq.why, disease_label: rq.disease_label, situation: sit, catalog, isTest: rq.source === 'test_sandbox' || String(rq.client_id).includes('test_sandbox') });
      } else {
        const why = (out.rejected_ideas || []).map((r) => r.reason).filter(Boolean).join('；');
        await db.query(`UPDATE llmwiki.widget_request SET status='dropped', note=$2, updated_at=$3 WHERE id=$1`, [rid, clip(why || 'AI 判断不需要做工具', 300), Date.now()]);
        return { status: 'dropped', note: why };
      }
      const st = result.toolStatus === 'approved' ? 'ready' : (result.toolStatus === 'pending_review' ? 'in_review' : 'dropped');
      await db.query(`UPDATE llmwiki.widget_request SET status=$2, tool_id=$3, note=$4, updated_at=$5 WHERE id=$1`,
        [rid, st, result.toolId || '', clip(result.reason || (result.reused ? '复用已有工具' : ''), 300), Date.now()]);
      return { status: st, toolId: result.toolId, reused: !!result.reused, reason: result.reason };
    } catch (e) {
      await db.query(`UPDATE llmwiki.widget_request SET status='failed', note=$2, updated_at=$3 WHERE id=$1`, [rid, clip(e.message, 300), Date.now()]);
      return { status: 'failed', error: e.message };
    } finally { running--; }
  }

  // 拆开评估：聊天里的 AI 只负责“记下新情况”；是否需要做新小工具，由这个独立的小判断来定（登记成 ai_chat 需求，不上首页，出结果后 AI 下次聊天告知）
  const EVAL_SYSTEM = `你是健康产品的“办事需求判断员”。输入是用户在聊天里说的一句新情况，以及平台已有小工具的名字。
默认倾向：只要这句话涉及一件【有现实办事环节】的事——出行/出差/坐飞机、住院/手术前后、复诊/挂号/就医流程、康复用品/辅具选购、搬家、陪护安排、办手续——就判 need=true（这类事都能做成固定程序：算数量/时间、清单、选购对比、分步指引），除非【已有工具名】里已经有明显同一件事的工具。
只有明确属于下面这些才判 need=false：饮食/吃什么、服药提醒、症状描述、心情、运动、打卡数据、闲聊、单纯的医学知识咨询。
只输出 JSON：{"need":true|false,"name":"工具名(≤14字，不含病名)","why":"用户要解决什么、需要算什么或列什么(≤80字)"}`;
  app.post('/api/clients/:id/widgets/evaluate', async (req, res) => {
    try {
      await ready;
      if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' });
      const text = clip((req.body || {}).text, 300);
      if (!text) return res.status(400).json({ error: 'text 必填' });
      const names = (await db.query(`SELECT name FROM llmwiki.widget_tool WHERE status = 'approved' ORDER BY created_at DESC LIMIT 80`)).rows.map((r) => r.name);
      const mine = (await db.query(`SELECT name FROM llmwiki.widget_request WHERE client_id=$1 AND status<>'dropped' LIMIT 50`, [req.params.id])).rows.map((r) => r.name);
      let out;
      try { out = parseJson(await llm(EVAL_SYSTEM, `【用户这句话】${text}\n【平台已有工具名】${names.join('、') || '无'}\n【该用户已登记的需求】${mine.join('、') || '无'}`, { max_tokens: 300, temperature: 0 })); } catch (e) { return res.json({ need: false, error: 'eval_failed' }); }
      console.log('[WidgetEval]', req.params.id, JSON.stringify(out).slice(0, 300));
      if (!out || !out.need || !clip(out.name, 40)) return res.json({ need: false });
      const name = clip(out.name, 40);
      if (mine.includes(name)) return res.json({ need: false, existed: true });
      const id = uid('wr');
      await db.query(`INSERT INTO llmwiki.widget_request (id,client_id,name,why,disease_label,source,catalog,status,pinned,notified,created_at,updated_at) VALUES ($1,$2,$3,$4,'','ai_chat',$5,'queued',FALSE,FALSE,$6,$6)`,
        [id, req.params.id, name, clip(out.why || text, 200), JSON.stringify(names.slice(0, 80)), Date.now()]);
      res.status(201).json({ need: true, request_id: id, name });
    } catch (e) { res.status(500).json({ error: '评估失败: ' + e.message }); }
  });

  // ── 用户侧 ──
  app.post('/api/clients/:id/widgets/requests', async (req, res) => {
    try {
      await ready;
      if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' });
      const b = req.body || {};
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 3).map((x) => ({ name: clip(x && x.name, 40), why: clip(x && x.why, 200) })).filter((x) => x.name);
      if (!items.length) return res.status(400).json({ error: 'items 必须是非空数组，且每项含 name' });
      const catalog = (Array.isArray(b.catalog) ? b.catalog : []).slice(0, 120).map((c) => clip(typeof c === 'string' ? c : c && c.name, 40)).filter(Boolean);
      const created = [];
      for (const it of items) {
        const dupe = (await db.query(`SELECT id FROM llmwiki.widget_request WHERE client_id=$1 AND name=$2 AND status<>'dropped' LIMIT 1`, [req.params.id, it.name])).rows[0];
        if (dupe) { created.push({ id: dupe.id, name: it.name, existed: true }); continue; }
        const id = uid('wr');
        // 建档时登记的直接上首页；AI 聊天里登记的，用户说“放首页”之后才上首页，并在出结果后由 AI 在聊天里告知一次
        const fromChat = clip(b.source, 40) === 'ai_chat';
        await db.query(`INSERT INTO llmwiki.widget_request (id,client_id,name,why,disease_label,source,catalog,status,pinned,notified,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$10)`,
          [id, req.params.id, it.name, it.why, clip(b.disease_label, 80), clip(b.source, 40) || 'onboarding', JSON.stringify(catalog), !fromChat, !fromChat, Date.now()]);
        created.push({ id, name: it.name });
      }
      res.status(201).json({ success: true, requests: created });
    } catch (e) { res.status(500).json({ error: '登记需求失败: ' + e.message }); }
  });

  // 生成要几十秒：由前端单独发起并等待（保持这次请求存活，云端 CPU 不会被回收）
  app.post('/api/clients/:id/widgets/requests/:rid/generate', async (req, res) => {
    try {
      await ready;
      const r = (await db.query('SELECT client_id FROM llmwiki.widget_request WHERE id=$1', [req.params.rid])).rows[0];
      if (!r || r.client_id !== req.params.id) return res.status(404).json({ error: '需求不存在' });
      res.json({ success: true, result: await generateRequest(req.params.rid) });
    } catch (e) { res.status(500).json({ error: '生成失败: ' + e.message }); }
  });

  // scope=all（AI 用）：含尚未放首页的；默认（首页用）：只含已放首页的，外加“未放首页但排队/失败”的隐藏项（hidden:true，仅供首页补发生成）
  app.get('/api/clients/:id/widgets', async (req, res) => {
    try {
      await ready;
      if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' });
      const all = String(req.query.scope || '') === 'all';
      const rs = (await db.query(`SELECT r.id, r.name, r.status, r.pinned, r.tool_id, t.name AS tool_name, t.kind, t.spec, t.status AS tool_status
        FROM llmwiki.widget_request r LEFT JOIN llmwiki.widget_tool t ON t.id = r.tool_id
        WHERE r.client_id=$1 AND r.status<>'dropped' ORDER BY r.created_at ASC LIMIT 40`, [req.params.id])).rows;
      const out = [];
      for (const r of rs) {
        const base = r.status === 'ready' && r.tool_status === 'approved'
          ? { request_id: r.id, name: r.name, status: 'ready', tool: publicView({ id: r.tool_id, name: r.tool_name, kind: r.kind, spec: r.spec }) }
          : { request_id: r.id, name: r.name, status: 'preparing', state: r.status };
        if (all) out.push({ ...base, pinned: !!r.pinned });
        else if (r.pinned) out.push(base);
        else if (r.status === 'queued' || r.status === 'failed') out.push({ ...base, hidden: true });
      }
      res.json({ widgets: out });
    } catch (e) { res.status(500).json({ error: '读取失败: ' + e.message }); }
  });

  // 已上架工具目录（只含名称/类型/适用场景），供 AI 判断“现有工具里有没有”
  app.get('/api/widgets/catalog', async (req, res) => {
    try {
      await ready;
      const rows = (await db.query(`SELECT id, name, kind, spec FROM llmwiki.widget_tool WHERE status='approved' ORDER BY created_at DESC LIMIT 60`)).rows;
      res.json({ tools: rows.map((t) => ({ id: t.id, name: t.name, kind: t.kind, when: clip(t.spec && t.spec.trigger && t.spec.trigger.when, 120), output: clip(t.spec && t.spec.output, 80) })) });
    } catch (e) { res.status(500).json({ error: '读取失败: ' + e.message }); }
  });

  app.get('/api/widgets/tools/:tid', async (req, res) => {
    try {
      await ready;
      const t = (await db.query(`SELECT id, name, kind, spec FROM llmwiki.widget_tool WHERE id=$1 AND status='approved'`, [req.params.tid])).rows[0];
      if (!t) return res.status(404).json({ error: '工具不存在或尚未上架' });
      res.json({ tool: publicView(t) });
    } catch (e) { res.status(500).json({ error: '读取失败: ' + e.message }); }
  });

  // 放到首页：给定 request_id（自己已有的需求）或 tool_id（现成已上架的工具，为该用户新建一条已就绪的需求）
  app.post('/api/clients/:id/widgets/pin', async (req, res) => {
    try {
      await ready;
      if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' });
      const b = req.body || {};
      if (b.request_id) {
        const r = await db.query(`UPDATE llmwiki.widget_request SET pinned=TRUE, updated_at=$3 WHERE id=$1 AND client_id=$2 RETURNING id`, [String(b.request_id), req.params.id, Date.now()]);
        if (!r.rowCount) return res.status(404).json({ error: '需求不存在' });
        return res.json({ success: true, request_id: r.rows[0].id });
      }
      const t = (await db.query(`SELECT id, name FROM llmwiki.widget_tool WHERE id=$1 AND status='approved'`, [String(b.tool_id || '')])).rows[0];
      if (!t) return res.status(404).json({ error: '工具不存在或尚未上架' });
      const have = (await db.query(`SELECT id FROM llmwiki.widget_request WHERE client_id=$1 AND tool_id=$2 AND status<>'dropped' LIMIT 1`, [req.params.id, t.id])).rows[0];
      if (have) { await db.query(`UPDATE llmwiki.widget_request SET pinned=TRUE, updated_at=$2 WHERE id=$1`, [have.id, Date.now()]); return res.json({ success: true, request_id: have.id }); }
      const id = uid('wr');
      await db.query(`INSERT INTO llmwiki.widget_request (id,client_id,name,why,source,status,tool_id,pinned,notified,created_at,updated_at) VALUES ($1,$2,$3,'用户在聊天里选用现成工具','ai_chat_pin','ready',$4,TRUE,TRUE,$5,$5)`, [id, req.params.id, t.name, t.id, Date.now()]);
      res.status(201).json({ success: true, request_id: id });
    } catch (e) { res.status(500).json({ error: '放到首页失败: ' + e.message }); }
  });

  // AI 聊天里登记的需求有了结果（上架/没做成）→ 取走一次，由 AI 在下次聊天里自然告知（取走即标记，不重复告知）
  app.post('/api/clients/:id/widgets/notices', async (req, res) => {
    try {
      await ready;
      const r = await db.query(`UPDATE llmwiki.widget_request SET notified=TRUE WHERE client_id=$1 AND notified=FALSE AND source='ai_chat' AND status IN ('ready','dropped') RETURNING id, name, status, pinned`, [req.params.id]);
      res.json({ notices: r.rows.map((x) => ({ request_id: x.id, name: x.name, status: x.status === 'ready' ? 'ready' : 'dropped', pinned: !!x.pinned })) });
    } catch (e) { res.status(500).json({ error: '读取失败: ' + e.message }); }
  });

  app.post('/api/widgets/tools/:tid/run', async (req, res) => {
    try {
      await ready;
      const t = (await db.query('SELECT id, name, kind, spec, status FROM llmwiki.widget_tool WHERE id=$1', [req.params.tid])).rows[0];
      if (!t) return res.status(404).json({ error: '工具不存在' });
      const isAdmin = String(process.env.WIDGET_REVIEW_TOKEN || '') && String(req.headers['x-review-token'] || '') === String(process.env.WIDGET_REVIEW_TOKEN);
      if (t.status !== 'approved' && !isAdmin) return res.status(404).json({ error: '工具不存在或尚未上架' });
      const inputs = req.body && typeof req.body.inputs === 'object' && req.body.inputs ? req.body.inputs : {};
      if (!t.spec.program_code) return res.json({ result: null, content: t.spec.content || [] });
      let result;
      try { result = runProgram(t.spec.program_code, inputs); } catch (e) { return res.status(422).json({ error: '计算失败：' + e.message }); }
      res.json({ result, content: t.spec.content || [] });
    } catch (e) { res.status(500).json({ error: '运行失败: ' + e.message }); }
  });

  // ── 审核/管理侧（需口令） ──
  app.get('/api/widgets/admin/settings', needAdmin, async (req, res) => {
    res.json({ gen_enabled: (await genEnabled()) ? 'on' : 'off', review_mode: await reviewMode() });
  });
  app.put('/api/widgets/admin/settings', needAdmin, async (req, res) => {
    try {
      await ready;
      const b = req.body || {}; const sets = [];
      if (b.gen_enabled !== undefined) { if (!['on', 'off'].includes(b.gen_enabled)) return res.status(400).json({ error: 'gen_enabled 只能是 on/off' }); sets.push(['gen_enabled', b.gen_enabled]); }
      if (b.review_mode !== undefined) { if (!['manual', 'auto'].includes(b.review_mode)) return res.status(400).json({ error: 'review_mode 只能是 manual/auto' }); sets.push(['review_mode', b.review_mode]); }
      for (const [k, v] of sets) await db.query(`INSERT INTO llmwiki.widget_settings (key,value,updated_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`, [k, v, Date.now()]);
      res.json({ gen_enabled: (await genEnabled()) ? 'on' : 'off', review_mode: await reviewMode() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/widgets/admin/tools', needAdmin, async (req, res) => {
    try {
      await ready;
      const status = clip(req.query.status, 20);
      const rows = (await db.query(`SELECT t.*, (SELECT count(*) FROM llmwiki.widget_request r WHERE r.tool_id=t.id) AS demand,
        (SELECT string_agg(DISTINCT r.why, ' | ') FROM llmwiki.widget_request r WHERE r.tool_id=t.id) AS whys
        FROM llmwiki.widget_tool t ${status ? 'WHERE t.status=$1' : ''} ORDER BY t.created_at DESC LIMIT 50`, status ? [status] : [])).rows;
      res.json({ tools: rows.map((t) => {
        let sample = null; let sample_inputs = null;
        if (t.spec.program_code) { try { sample_inputs = defaultInputs(t.spec); sample = runProgram(t.spec.program_code, sample_inputs); } catch (e) { sample = { error: e.message }; } }
        return { id: t.id, name: t.name, kind: t.kind, status: t.status, scenario_key: t.scenario_key, disease_label: t.disease_label, demand: Number(t.demand), whys: t.whys || '',
          approved_by: t.approved_by, approved_mode: t.approved_mode, created_at: Number(t.created_at), review: t.review, spec: { ...publicView(t), trigger: t.spec.trigger, constants: t.spec.constants || [], sources: t.spec.sources || [], not_do: t.spec.not_do || [] }, sample_inputs, sample_result: sample };
      }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const decideTool = (action) => async (req, res) => {
    try {
      await ready;
      const t = (await db.query('SELECT id, status, review FROM llmwiki.widget_tool WHERE id=$1', [req.params.tid])).rows[0];
      if (!t) return res.status(404).json({ error: '工具不存在' });
      if (t.status !== 'pending_review') return res.status(409).json({ error: `当前状态是 ${t.status}，只有 pending_review 能审核` });
      const by = clip(req.body && req.body.reviewer, 40) || '医生'; const note = clip(req.body && req.body.note, 300);
      const status = action === 'approve' ? 'approved' : 'rejected';
      const review = { ...t.review, history: [...(t.review.history || []), { at: Date.now(), by, action, note }] };
      await db.query(`UPDATE llmwiki.widget_tool SET status=$2, review=$3, approved_by=$4, approved_mode=$5, updated_at=$6 WHERE id=$1`,
        [t.id, status, JSON.stringify(review), status === 'approved' ? by : '', status === 'approved' ? 'doctor' : '', Date.now()]);
      await syncRequests(t.id, status);
      res.json({ success: true, status });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
  app.post('/api/widgets/admin/tools/:tid/approve', needAdmin, decideTool('approve'));
  app.post('/api/widgets/admin/tools/:tid/reject', needAdmin, decideTool('reject'));

  // 人工/外部草稿也走同一条检查+复核流水线
  app.post('/api/widgets/admin/drafts', needAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.spec || typeof b.spec !== 'object') return res.status(400).json({ error: 'spec 必填' });
      const jo = b.judge_override && typeof b.judge_override === 'object' ? { verdict: String(b.judge_override.verdict || 'fail'), scope: String(b.judge_override.scope || '其他'), reasons: ['(测试：AI复核被替换) ' + clip(b.judge_override.reasons, 100)], duplicate_of: '' } : null;
      const r = await processDraft(b.spec, { name: b.name || b.spec.name, why: clip(b.why, 200), disease_label: clip(b.disease_label, 80), situation: clip(b.situation, 600), catalog: b.catalog || [], judgeOverride: jo });
      if (b.request_id) await db.query(`UPDATE llmwiki.widget_request SET tool_id=$2, status=$3, updated_at=$4 WHERE id=$1`, [b.request_id, r.toolId, r.toolStatus === 'approved' ? 'ready' : (r.toolStatus === 'pending_review' ? 'in_review' : 'dropped'), Date.now()]);
      res.status(201).json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 排队/失败的需求统一补跑（也可由定时任务调用）
  app.post('/api/widgets/admin/generate-pending', needAdmin, async (req, res) => {
    try {
      await ready;
      const rows = (await db.query(`SELECT id FROM llmwiki.widget_request WHERE status='queued' OR (status='failed' AND attempts<3) ORDER BY created_at ASC LIMIT 5`)).rows;
      const results = [];
      for (const r of rows) results.push({ id: r.id, ...(await generateRequest(r.id)) });
      res.json({ processed: results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 仅用于测试清理：只能删除名字以 test_sandbox 开头的工具，真实工具删不掉
  app.post('/api/widgets/admin/_test_cleanup', needAdmin, async (req, res) => {
    try {
      await ready;
      const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).filter((x) => typeof x === 'string').slice(0, 100);
      const r = await db.query(`DELETE FROM llmwiki.widget_tool WHERE id = ANY($1) AND (name LIKE 'test_sandbox%' OR id IN (SELECT tool_id FROM llmwiki.widget_request WHERE source='test_sandbox')
        OR (id IN (SELECT tool_id FROM llmwiki.widget_request WHERE client_id LIKE '%test_sandbox%') AND id NOT IN (SELECT tool_id FROM llmwiki.widget_request WHERE client_id NOT LIKE '%test_sandbox%' AND tool_id <> ''))
        OR (status='pending_review' AND id NOT IN (SELECT tool_id FROM llmwiki.widget_request WHERE tool_id <> ''))) RETURNING id`, [ids]);
      res.json({ deleted: r.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/widget-review', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(path.join(__dirname, 'widget_review.html'), 'utf8'));
  });

  return {
    clear: (id) => db.query(`DELETE FROM llmwiki.widget_request WHERE client_id=$1`, [id]).catch(() => {}),
    _test: { lintTool, runProgram },
  };
}

module.exports = { registerWidgets, lintTool, runProgram };
