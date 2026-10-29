/**
 * state.cjs — 健康信息“过去 / 现在 / 未来”三层：唯一读取入口 + 状态与更正存储
 * 设计：skill-platform/doc/three_layer_health_state_design.md
 *
 *   GET   /api/clients/:id/state              三层状态（JSON + 给 AI 的文本 ai_text）
 *   PATCH /api/clients/:id/state              更新“现在·状态”（称呼/习惯/过敏/症状/自述用药…）
 *   POST  /api/clients/:id/corrections        追加“过去·理解”的更正（原文不改）
 *
 * “现在·今日”（台账：打卡/血压…）不在这里，由 skill-platform 读台账后并入。
 * 本模块只读不改计划；计划修改仍走 /plans/proposals（提议）→ 用户确认。
 */
const crypto = require('crypto');

// 还没有健康计划时，首页和 AI 共用的“通用建议目标”（唯一定义处；不是医嘱）。首页“今日精选自护行动”与步数目标都读这里。
const DEFAULT_GOALS = [
  { key: 'default_steps', line: 'exercise', title: '累计完成今日 8,000 步轻快走', detail: '餐后散步 20 分钟，量力而行', target: { kind: 'steps', value: 8000 } },
  { key: 'default_water', line: 'diet', title: '全天饮水约 2000 ml', detail: '少量多次；如医生要求限水，以医生为准', target: { kind: 'water_ml', value: 2000 } },
  { key: 'default_sleep', line: 'environment', title: '23:00 前熄灯就寝', detail: '保证 7 小时左右睡眠', target: { kind: 'sleep_by', value: '23:00' } },
];
const ORDER_LINES = ['medication', 'monitor'];           // 未来·医嘱：药、复查监测
const GOAL_LINES = ['diet', 'exercise', 'environment'];  // 未来·目标/生活要求
const STATE_KEYS = ['record_name', 'preferred_name', 'nickname', 'habits', 'preferences', 'allergies', 'symptoms', 'self_reported_meds', 'stage', 'notes'];
const ARRAY_KEYS = ['habits', 'preferences', 'allergies', 'symptoms', 'self_reported_meds', 'notes'];

const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t; };
const strip = (s) => String(s || '').replace(/\[🔗 溯源\]\([^)]*\)/g, '').replace(/```[\s\S]*?```/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function registerState(app, { db, findClient, planApi, readWikiPages, readLogs }) {
  // 建表：失败（如启动时数据库连接超时）不会“永久失败”，下一个请求会重试，直到成功为止
  let tablesOk = null;
  const ensureTables = () => {
    if (!tablesOk) {
      tablesOk = (async () => {
        await db.query(`CREATE TABLE IF NOT EXISTS llmwiki.client_state (client_id TEXT PRIMARY KEY, state JSONB NOT NULL DEFAULT '{}', updated_at BIGINT)`, []);
        await db.query(`CREATE TABLE IF NOT EXISTS llmwiki.client_corrections (
          id TEXT PRIMARY KEY, client_id TEXT NOT NULL, target TEXT, before_text TEXT, after_text TEXT, said TEXT, source TEXT, created_at BIGINT)`, []);
        await db.query(`CREATE INDEX IF NOT EXISTS client_corrections_client_idx ON llmwiki.client_corrections (client_id, created_at)`, []);
      })().catch((e) => { console.error('[State] ensureTables failed (will retry):', e.message); tablesOk = null; throw e; });
    }
    return tablesOk;
  };
  ensureTables().catch(() => {});
  const ready = { then: (res, rej) => ensureTables().then(res, rej) }; // await ready → 确保表已建好

  const getStateRow = async (id) => {
    const r = await db.query(`SELECT state, updated_at FROM llmwiki.client_state WHERE client_id=$1`, [id]);
    return { state: (r.rows[0] && r.rows[0].state) || {}, updated_at: Number((r.rows[0] && r.rows[0].updated_at) || 0) };
  };
  const getCorrections = async (id) => {
    const r = await db.query(`SELECT id, target, before_text, after_text, said, source, created_at FROM llmwiki.client_corrections WHERE client_id=$1 ORDER BY created_at ASC`, [id]);
    return r.rows.map((x) => ({ id: x.id, target: x.target, before: x.before_text, after: x.after_text, said: x.said, source: x.source, at: Number(x.created_at) }));
  };

  async function buildState(id) {
    await ready;
    const client = await findClient(id);
    if (!client) return null;
    const [pages, active, stRow, corrections, logs] = await Promise.all([
      readWikiPages(id).catch(() => ({})),
      planApi.getActive(id).catch(() => null),
      getStateRow(id).catch(() => ({ state: {}, updated_at: 0 })),
      getCorrections(id).catch(() => []),
      readLogs(id).catch(() => []),
    ]);
    let drafts = [];
    try {
      const r = await db.query(`SELECT id, version, reason, proposed_by, source, created_at, changes FROM llmwiki.plan_versions WHERE client_id=$1 AND status='draft' ORDER BY created_at DESC LIMIT 5`, [id]);
      drafts = r.rows.map((d) => ({ id: d.id, reason: clip(d.reason, 160), proposed_by: d.proposed_by, source: d.source, at: Number(d.created_at), changes: Array.isArray(d.changes) ? d.changes.length : 0 }));
    } catch (e) { /* 计划表不存在时忽略 */ }

    const reports = (Array.isArray(logs) ? logs : [])
      .filter((l) => l.type === 'ocr' || l.type === 'ai_report')
      .slice(-6)
      .map((l) => ({ id: l.id, at: l.timestamp, title: clip(l.title, 40), excerpt: clip(strip(l.content).replace(/\s+/g, ' '), 220) }));

    const items = active ? (active.items || []) : [];
    const pick = (lines) => items.filter((i) => lines.includes(i.line)).map((i) => ({ key: i.key, line: i.line, title: i.title, detail: clip(i.detail, 200), evidence: clip(i.evidence, 160) }));
    const validity = active && planApi.validityState ? planApi.validityState(active) : null;

    const st = stRow.state || {};
    const state = {
      record_name: st.record_name || '', preferred_name: st.preferred_name || '', nickname: st.nickname || client.name || '',
      habits: st.habits || [], preferences: st.preferences || [], allergies: st.allergies || (client.allergies && client.allergies !== '无' ? [client.allergies] : []),
      symptoms: st.symptoms || [], self_reported_meds: st.self_reported_meds || [], stage: st.stage || '', notes: st.notes || [],
      profile_text: clip(strip(pages['user_profile.md']), 900),
    };

    const out = {
      client: { id, name: client.name, age: client.age, gender: client.gender },
      past: {
        history_text: clip(strip(pages['medical_history.md']), 2000),
        reports,
        corrections,
      },
      present: { state, state_updated_at: stRow.updated_at },
      future: {
        plan: active ? { id: active.id, version: active.version, phase_title: active.phase_title, primary_goal: active.primary_goal, confirmed_at: active.confirmed_at || null } : null,
        validity,
        orders: pick(ORDER_LINES),
        goals: pick(GOAL_LINES),
        default_goals: active ? [] : DEFAULT_GOALS,
        pending_proposals: drafts,
      },
    };
    out.version = hash([active ? `${active.id}:${active.version}:${JSON.stringify(active.meta && active.meta.validity || {})}` : 'none', stRow.updated_at, corrections.length, corrections.length ? corrections[corrections.length - 1].at : 0, drafts.map((d) => d.id).join(','), (logs || []).length].join('|'));
    out.ai_text = renderStateText(out);
    return out;
  }

  app.get('/api/clients/:id/state', async (req, res) => {
    try {
      const s = await buildState(req.params.id);
      if (!s) return res.status(404).json({ error: '客户不存在' });
      res.json(s);
    } catch (err) { res.status(500).json({ error: '读取状态失败: ' + err.message }); }
  });

  // 更新“现在·状态”：set=覆盖字段；add/remove=对数组字段增删（按文本去重）。只接受白名单字段。
  app.patch('/api/clients/:id/state', async (req, res) => {
    try {
      await ready;
      const id = req.params.id;
      if (!await findClient(id)) return res.status(404).json({ error: '客户不存在' });
      const { set = {}, add = {}, remove = {}, by = '' } = req.body || {};
      const cur = (await getStateRow(id)).state || {};
      const next = { ...cur };
      for (const [k, v] of Object.entries(set)) if (STATE_KEYS.includes(k)) next[k] = v;
      const keyOf = (x) => (typeof x === 'string' ? x : (x && (x.name || x.text)) || JSON.stringify(x));
      for (const [k, v] of Object.entries(add)) {
        if (!ARRAY_KEYS.includes(k)) continue;
        const arr = Array.isArray(next[k]) ? next[k].slice() : [];
        for (const it of (Array.isArray(v) ? v : [v])) {
          const withMeta = typeof it === 'object' && it ? { ...it, at: it.at || Date.now(), by: it.by || by || 'user' } : it;
          const i = arr.findIndex((x) => keyOf(x) === keyOf(it));
          if (i >= 0) arr[i] = withMeta; else arr.push(withMeta);
        }
        next[k] = arr;
      }
      for (const [k, v] of Object.entries(remove)) {
        if (!ARRAY_KEYS.includes(k)) continue;
        const del = (Array.isArray(v) ? v : [v]).map(keyOf);
        next[k] = (Array.isArray(next[k]) ? next[k] : []).filter((x) => !del.includes(keyOf(x)));
      }
      const now = Date.now();
      await db.query(`INSERT INTO llmwiki.client_state (client_id, state, updated_at) VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (client_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`, [id, JSON.stringify(next), now]);
      res.json({ success: true, state: next, updated_at: now });
    } catch (err) { res.status(500).json({ error: '更新状态失败: ' + err.message }); }
  });

  // 追加“过去·理解”的更正：原始记录不动，只追加一条更正
  app.post('/api/clients/:id/corrections', async (req, res) => {
    try {
      await ready;
      const id = req.params.id;
      if (!await findClient(id)) return res.status(404).json({ error: '客户不存在' });
      const { target = '', before = '', after = '', said = '', source = 'user' } = req.body || {};
      if (!String(after).trim() && !String(said).trim()) return res.status(400).json({ error: 'after 或 said 必填' });
      const cid = `corr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await db.query(`INSERT INTO llmwiki.client_corrections (id, client_id, target, before_text, after_text, said, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [cid, id, clip(target, 80), clip(before, 500), clip(after, 500), clip(said, 500), clip(source, 40), Date.now()]);
      res.status(201).json({ success: true, id: cid });
    } catch (err) { res.status(500).json({ error: '追加更正失败: ' + err.message }); }
  });

  /** 同步（sync）用：把聊天里用户自述的用药变化记到“现在·状态”的备注（不写进 wiki 用药页、也不改计划） */
  async function addSyncNotes(id, notes) {
    if (!notes || !notes.length) return;
    await ready;
    const cur = (await getStateRow(id)).state || {};
    const arr = Array.isArray(cur.notes) ? cur.notes.slice() : [];
    for (const n of notes) {
      const text = String(n.text || '').slice(0, 200);
      if (text && !arr.some((x) => (x && (x.text || x)) === text)) arr.push({ text, by: 'sync', log_id: n.log_id || '', at: Date.now() });
    }
    const next = { ...cur, notes: arr.slice(-30) };
    await db.query(`INSERT INTO llmwiki.client_state (client_id, state, updated_at) VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (client_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`, [id, JSON.stringify(next), Date.now()]);
  }

  return { buildState, addSyncNotes };
}

/** 三层状态 → 给 AI 的文本（文字与语音共用；“今日”部分由 skill-platform 追加） */
function renderStateText(s) {
  const L = [];
  const st = s.present.state;
  L.push('【过去·原始（病历与报告，只读）】');
  L.push(s.past.history_text || '（暂无病历记录）');
  if (s.past.reports.length) L.push('报告：' + s.past.reports.map((r) => `${r.title}（${String(r.at || '').slice(0, 10)}）：${r.excerpt}`).join('\n'));
  if (s.past.corrections.length) {
    L.push('【过去·更正（以更正后为准，原文保留）】');
    s.past.corrections.forEach((c) => L.push(`- ${c.target ? c.target + '：' : ''}${c.before ? `“${c.before}”→` : ''}${c.after || c.said}（${new Date(c.at).toISOString().slice(0, 10)}）`));
  }
  L.push('');
  L.push('【现在·状态（长期有效）】');
  const kv = [];
  if (st.record_name) kv.push(`病历姓名：${st.record_name}`);
  if (st.preferred_name) kv.push(`希望的称呼：${st.preferred_name}`);
  if (st.nickname) kv.push(`昵称：${st.nickname}`);
  if (st.stage) kv.push(`当前阶段：${st.stage}`);
  const arr = (label, a, f) => { if (a && a.length) kv.push(`${label}：${a.map(f || ((x) => (typeof x === 'string' ? x : x.text || x.name || JSON.stringify(x)))).join('；')}`); };
  arr('过敏', st.allergies); arr('习惯', st.habits); arr('偏好', st.preferences); arr('当前症状', st.symptoms);
  arr('用户自述的用药现状（不等于医嘱）', st.self_reported_meds, (m) => `${m.name}：${m.status || ''}${m.said ? `（原话：${m.said}）` : ''}`);
  arr('备注', st.notes);
  L.push(kv.length ? kv.join('\n') : '（暂无）');
  if (st.profile_text) L.push(st.profile_text);
  L.push('');
  const f = s.future;
  L.push('【未来·健康计划（医嘱以此为准；只能提议修改，需用户确认）】');
  if (!f.plan) {
    L.push('（暂无生效的健康计划）');
    if (f.default_goals && f.default_goals.length) L.push('首页显示的通用建议目标（不是医嘱，用户还没有健康计划）：' + f.default_goals.map((g) => g.title).join('；'));
  }
  else {
    L.push(`计划：${f.plan.phase_title || ''}${f.plan.version ? `（v${f.plan.version}）` : ''}`);
    if (f.validity && f.validity.state) L.push(`医嘱有效性：${f.validity.state}${f.validity.ref_date ? `，依据 ${f.validity.ref_date}` : ''}`);
    if (f.orders.length) { L.push('医嘱（药/复查）：'); f.orders.forEach((o, i) => L.push(`${i + 1}. ${o.title}${o.detail ? '：' + o.detail : ''}`)); }
    if (f.goals.length) { L.push('生活要求/目标：'); f.goals.forEach((o) => L.push(`- ${o.title}${o.detail ? '：' + o.detail : ''}`)); }
  }
  if (f.pending_proposals.length) L.push(`待用户确认的计划修改：${f.pending_proposals.length} 条（未生效）`);
  return L.join('\n');
}

module.exports = { registerState, renderStateText, ORDER_LINES, GOAL_LINES, DEFAULT_GOALS };

