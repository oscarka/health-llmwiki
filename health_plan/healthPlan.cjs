/**
 * 健康计划模块（与"健康档案 Wiki"并列的独立板块）
 *
 * 设计原则（见 skill-platform/doc/health_plan_design.md）：
 *  - 档案 = 已发生的事实/证据（AI 同步写入）；计划 = 将要做的事（本模块，程序确定性写入，不经 AI 改写）
 *  - 计划有版本：draft(提案) → active(生效) → superseded(已被取代)；同一时刻只有一个 active
 *  - 提案只是草稿，确认才生效；基于旧版本的提案在新版本生效后失效（防止新旧冲突）
 *  - 计划项按 key 唯一，后确认的来源覆盖前面的值，旧值保留在历史版本里
 *  - 确认/调整会在档案日志里留一条"事件"（只记事实，不存计划正文）
 */
const crypto = require('crypto');

const LINES = ['diet', 'exercise', 'monitor', 'medication', 'environment'];
const LINE_LABEL = { diet: '饮食', exercise: '运动', monitor: '监测', medication: '用药', environment: '起居与服务' };
const SOURCES = ['system', 'nutritionist', 'doctor', 'user', 'ai'];
const SOURCE_LABEL = { system: '系统基础版', nutritionist: '营养师', doctor: '医生', user: '用户自定', ai: 'AI 建议' };
const COMPARATORS = ['gte', 'lte', 'between', 'eq', 'count_gte'];
const PERIODS = ['day', 'week'];
const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;

const uid = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

/** 校验并规范化一个计划项；返回 { item } 或 { error } */
function normalizeItem(raw, defaultSource) {
  if (!raw || typeof raw !== 'object') return { error: '计划项必须是对象' };
  const key = String(raw.key || '').trim();
  if (!/^[a-z0-9_.]{2,60}$/.test(key)) return { error: `计划项 key 不合法（只允许小写字母/数字/下划线/点）：${key || '(空)'}` };
  if (!LINES.includes(raw.line)) return { error: `计划项 ${key} 的 line 必须是：${LINES.join('/')}` };
  const title = String(raw.title || '').trim();
  if (!title) return { error: `计划项 ${key} 缺少 title` };
  const source = raw.source || defaultSource || 'system';
  if (!SOURCES.includes(source)) return { error: `计划项 ${key} 的 source 必须是：${SOURCES.join('/')}` };
  const item = { key, line: raw.line, title: title.slice(0, 80), detail: String(raw.detail || '').slice(0, 4000), source };
  if (raw.target !== undefined && raw.target !== null) {
    const t = raw.target;
    if (typeof t !== 'object') return { error: `计划项 ${key} 的 target 必须是对象` };
    if (!COMPARATORS.includes(t.comparator)) return { error: `计划项 ${key} 的 target.comparator 必须是：${COMPARATORS.join('/')}` };
    if (t.period !== undefined && !PERIODS.includes(t.period)) return { error: `计划项 ${key} 的 target.period 必须是：${PERIODS.join('/')}` };
    const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const value = num(t.value), min = num(t.min), max = num(t.max);
    if (t.comparator === 'between') {
      if (!isFinite(min) || !isFinite(max) || min > max) return { error: `计划项 ${key} 的 between 需要 min<=max` };
    } else if (!isFinite(value)) {
      return { error: `计划项 ${key} 的 target.value 必须是数字` };
    }
    item.target = { metric: String(t.metric || '').slice(0, 40), comparator: t.comparator, unit: String(t.unit || '').slice(0, 20), period: t.period || 'day' };
    if (value !== undefined) item.target.value = value;
    if (min !== undefined) item.target.min = min;
    if (max !== undefined) item.target.max = max;
  }
  if (raw.binding) {
    const b = raw.binding;
    if (!['ledger', 'manual'].includes(b.kind)) return { error: `计划项 ${key} 的 binding.kind 必须是 ledger/manual` };
    item.binding = { kind: b.kind };
    if (b.kind === 'ledger') item.binding.recordKind = String(b.recordKind || '').slice(0, 30);
  }
  return { item };
}

const sameItem = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 在生效项上应用补丁，返回 { items, changes } */
function applyPatch(baseItems, patchItems, removeKeys) {
  const map = new Map(baseItems.map((i) => [i.key, i]));
  const changes = [];
  for (const it of patchItems) {
    const before = map.get(it.key);
    if (!before) { changes.push({ op: 'add', key: it.key, after: it }); map.set(it.key, it); }
    else if (!sameItem(before, it)) { changes.push({ op: 'update', key: it.key, before, after: it }); map.set(it.key, it); }
  }
  for (const k of removeKeys) {
    const before = map.get(k);
    if (before) { changes.push({ op: 'remove', key: k, before }); map.delete(k); }
  }
  return { items: [...map.values()], changes };
}

const targetText = (t) => {
  if (!t) return '';
  const u = t.unit || '';
  const per = t.period === 'week' ? '每周' : '每天';
  if (t.comparator === 'gte') return `${per}≥${t.value}${u}`;
  if (t.comparator === 'lte') return `${per}≤${t.value}${u}`;
  if (t.comparator === 'eq') return `${per}${t.value}${u}`;
  if (t.comparator === 'count_gte') return `${per}至少${t.value}${u || '次'}`;
  if (t.comparator === 'between') return `${per}${t.min}~${t.max}${u}`;
  return '';
};

/** 给 AI 管家看的"一页纸"摘要（短，只含生效版本） */
function renderPlanSummary(active) {
  if (!active) return '';
  const lines = [`【健康计划·生效版本 v${active.version}】`];
  if (active.phase_title) lines.push(`阶段：${active.phase_title}`);
  if (active.primary_goal) lines.push(`总目标：${active.primary_goal}`);
  for (const ln of LINES) {
    const its = active.items.filter((i) => i.line === ln);
    if (!its.length) continue;
    lines.push(`${LINE_LABEL[ln]}：` + its.map((i) => {
      const tt = targetText(i.target);
      const src = i.source && i.source !== 'system' ? `（${SOURCE_LABEL[i.source]}）` : '';
      return `${i.title}${tt ? ' ' + tt : ''}${src}`;
    }).join('；'));
  }
  return lines.join('\n');
}

const rowToPlan = (r) => !r ? null : ({
  id: r.id, client_id: r.client_id, version: r.version, status: r.status,
  phase_title: r.phase_title || '', primary_goal: r.primary_goal || '',
  items: r.items || [], changes: r.changes || [], reason: r.reason || '',
  proposed_by: r.proposed_by || '', source: r.source || '', base_version: r.base_version,
  created_at: r.created_at ? Number(r.created_at) : null,
  confirmed_at: r.confirmed_at ? Number(r.confirmed_at) : null,
});

function registerHealthPlan(app, { db, findClient, appendLog }) {
  const ensureTables = async () => {
    try {
      await db.query(`CREATE TABLE IF NOT EXISTS llmwiki.plan_versions (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, version INT, status TEXT NOT NULL,
        phase_title TEXT, primary_goal TEXT, items JSONB NOT NULL DEFAULT '[]', changes JSONB NOT NULL DEFAULT '[]',
        reason TEXT, proposed_by TEXT, source TEXT, base_version INT, created_at BIGINT, confirmed_at BIGINT)`, []);
      await db.query(`CREATE INDEX IF NOT EXISTS plan_versions_client_idx ON llmwiki.plan_versions (client_id, status)`, []);
    } catch (e) { console.error('[HealthPlan] ensureTables failed:', e.message); }
  };
  const ready = ensureTables();

  const getActive = async (clientId) => {
    const r = await db.query(`SELECT * FROM llmwiki.plan_versions WHERE client_id=$1 AND status='active' ORDER BY version DESC LIMIT 1`, [clientId]);
    return rowToPlan(r.rows[0]);
  };
  const expireOldDrafts = async (clientId) => {
    await db.query(`UPDATE llmwiki.plan_versions SET status='expired' WHERE client_id=$1 AND status='draft' AND created_at < $2`, [clientId, Date.now() - DRAFT_TTL_MS]);
  };
  const needClient = async (req, res) => {
    await ready;
    if (!await findClient(req.params.id)) { res.status(404).json({ error: '客户不存在' }); return false; }
    return true;
  };

  // 1. 计划总览：生效版本 + 待确认提案 + 历史版本（不含 items）
  app.get('/api/clients/:id/plans', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const id = req.params.id;
      await expireOldDrafts(id);
      const active = await getActive(id);
      const drafts = (await db.query(`SELECT * FROM llmwiki.plan_versions WHERE client_id=$1 AND status='draft' ORDER BY created_at DESC`, [id])).rows.map(rowToPlan);
      const history = (await db.query(`SELECT * FROM llmwiki.plan_versions WHERE client_id=$1 AND status IN ('active','superseded') ORDER BY version DESC`, [id])).rows.map(rowToPlan)
        .map((p) => ({ ...p, items: undefined, item_count: p.items.length }));
      res.json({ active, drafts, history, summary: renderPlanSummary(active) });
    } catch (err) { res.status(500).json({ error: '读取计划失败: ' + err.message }); }
  });

  // 2. 仅生效版本 + 摘要（管家常用）
  app.get('/api/clients/:id/plans/active', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const active = await getActive(req.params.id);
      res.json({ active, summary: renderPlanSummary(active) });
    } catch (err) { res.status(500).json({ error: '读取生效计划失败: ' + err.message }); }
  });

  // 3. 某个历史版本全文
  app.get('/api/clients/:id/plans/versions/:version', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const r = await db.query(`SELECT * FROM llmwiki.plan_versions WHERE client_id=$1 AND version=$2 AND status IN ('active','superseded')`, [req.params.id, Number(req.params.version)]);
      if (!r.rows[0]) return res.status(404).json({ error: '版本不存在' });
      res.json(rowToPlan(r.rows[0]));
    } catch (err) { res.status(500).json({ error: '读取版本失败: ' + err.message }); }
  });

  // 4. 创建提案（草稿）：patch=在生效计划上增改删；首次计划用 items 全量
  app.post('/api/clients/:id/plans/proposals', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const id = req.params.id;
      const b = req.body || {};
      const source = b.source || 'system';
      if (!SOURCES.includes(source)) return res.status(400).json({ error: `source 必须是：${SOURCES.join('/')}` });
      const reason = String(b.reason || '').trim();
      if (!reason) return res.status(400).json({ error: '必须说明 reason（为什么提出这次计划/调整）' });
      const rawItems = Array.isArray(b.items) ? b.items : [];
      const patchItems = [];
      for (const r of rawItems) {
        const n = normalizeItem(r, source);
        if (n.error) return res.status(400).json({ error: n.error });
        patchItems.push(n.item);
      }
      const removeKeys = Array.isArray(b.remove) ? b.remove.map(String) : [];
      const active = await getActive(id);
      if (!active && patchItems.length === 0) return res.status(400).json({ error: '首次计划必须提供 items' });
      const base = active ? active.items : [];
      const { items, changes } = applyPatch(base, patchItems, removeKeys);
      const phase_title = b.phase_title !== undefined ? String(b.phase_title).slice(0, 80) : (active ? active.phase_title : '');
      const primary_goal = b.primary_goal !== undefined ? String(b.primary_goal).slice(0, 200) : (active ? active.primary_goal : '');
      const metaChanged = active && (phase_title !== active.phase_title || primary_goal !== active.primary_goal);
      if (changes.length === 0 && !metaChanged && active) return res.status(400).json({ error: '提案与当前生效计划没有任何差别' });
      const pid = uid('pv');
      await db.query(`INSERT INTO llmwiki.plan_versions (id, client_id, version, status, phase_title, primary_goal, items, changes, reason, proposed_by, source, base_version, created_at)
        VALUES ($1,$2,NULL,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [pid, id, phase_title, primary_goal, JSON.stringify(items), JSON.stringify(changes), reason, String(b.proposed_by || 'system').slice(0, 30), source, active ? active.version : 0, Date.now()]);
      const row = (await db.query(`SELECT * FROM llmwiki.plan_versions WHERE id=$1`, [pid])).rows[0];
      res.status(201).json(rowToPlan(row));
    } catch (err) { res.status(500).json({ error: '创建提案失败: ' + err.message }); }
  });

  // 5. 确认提案 → 新版本生效，旧版本变"已取代"，档案留事件
  app.post('/api/clients/:id/plans/proposals/:pid/confirm', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const { id, pid } = req.params;
      const r = await db.query(`SELECT * FROM llmwiki.plan_versions WHERE id=$1 AND client_id=$2`, [pid, id]);
      const d = r.rows[0];
      if (!d) return res.status(404).json({ error: '提案不存在' });
      if (d.status !== 'draft') return res.status(409).json({ error: `提案状态为 ${d.status}，不能确认` });
      const active = await getActive(id);
      const curVer = active ? active.version : 0;
      if (Number(d.base_version) !== curVer) {
        await db.query(`UPDATE llmwiki.plan_versions SET status='expired' WHERE id=$1`, [pid]);
        return res.status(409).json({ error: `提案基于 v${d.base_version}，当前已是 v${curVer}，请基于最新计划重新提出` });
      }
      const newVer = curVer + 1;
      const now = Date.now();
      // 条件更新：只有仍是 draft 才生效，防止重复确认
      const upd = await db.query(`UPDATE llmwiki.plan_versions SET status='active', version=$1, confirmed_at=$2 WHERE id=$3 AND status='draft' RETURNING id`, [newVer, now, pid]);
      if (!upd.rows[0]) return res.status(409).json({ error: '提案已被处理' });
      if (active) await db.query(`UPDATE llmwiki.plan_versions SET status='superseded' WHERE id=$1`, [active.id]);
      // 其它基于旧版本的草稿作废
      await db.query(`UPDATE llmwiki.plan_versions SET status='expired' WHERE client_id=$1 AND status='draft' AND base_version<$2`, [id, newVer]);
      const plan = rowToPlan((await db.query(`SELECT * FROM llmwiki.plan_versions WHERE id=$1`, [pid])).rows[0]);
      // 档案事件（只记事实，不存计划正文）
      try {
        const lbl = (c) => `${c.op === 'add' ? '新增' : c.op === 'remove' ? '移除' : '调整'}「${(c.after || c.before).title}」`;
        const content = `【计划事件】${newVer === 1 ? '确认首份健康计划 v1' : `健康计划由 v${curVer} 调整为 v${newVer}`}（来源：${SOURCE_LABEL[plan.source] || plan.source}）。` +
          (plan.changes.length && newVer > 1 ? `变更：${plan.changes.slice(0, 8).map(lbl).join('、')}。` : '') + `原因：${plan.reason}`;
        await appendLog(id, { id: `log_${now}_${crypto.randomBytes(2).toString('hex')}`, type: 'wechat', title: `计划事件：v${newVer} 生效`, content, created_at: now, synced: true /* 审计留痕，不是临床事实：不进 AI 同步，避免被误写成"干预措施" */ });
      } catch (e) { console.error('[HealthPlan] 写档案事件失败（不影响确认）:', e.message); }
      res.json({ success: true, plan, summary: renderPlanSummary(plan) });
    } catch (err) { res.status(500).json({ error: '确认提案失败: ' + err.message }); }
  });

  // 6. 拒绝提案
  app.post('/api/clients/:id/plans/proposals/:pid/reject', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const { id, pid } = req.params;
      const upd = await db.query(`UPDATE llmwiki.plan_versions SET status='rejected' WHERE id=$1 AND client_id=$2 AND status='draft' RETURNING id`, [pid, id]);
      if (!upd.rows[0]) return res.status(404).json({ error: '没有可拒绝的待确认提案' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: '拒绝提案失败: ' + err.message }); }
  });

  return { getActive: async (id) => { await ready; return getActive(id); }, renderPlanSummary };
}

module.exports = { registerHealthPlan, normalizeItem, applyPatch, renderPlanSummary, LINES, LINE_LABEL, SOURCE_LABEL, SOURCES };
