/**
 * 「医嘱是否仍有效」：由用户声明、系统记录；模型不替医生判断医嘱对不对。
 *
 *  - 模型能做的只有两件事：
 *      1) 估计“用户确认后，隔多久该再提醒核对一次”（按病情性质/材料类型/材料多旧；不写死病种-天数表）
 *      2) 把用户口述的“哪些变了”整理成一份【待确认草稿】（走既有 proposal/confirm 流程，用户点确认才生效）
 *  - “确认有效 / 暂不执行”只改有效性状态（meta.validity）与相应文案，不改药名、剂量、计划条目含义。
 *  - 不强制上传新报告：用户可选 上传新材料 / 告诉 AI 哪些变了 / 先不执行（待复诊确认）。
 */
const mp = require('./materialPlan.cjs');
const { validityState } = require('./healthPlan.cjs');

const DAY = 86400000;
const MIN_DAYS = 7, MAX_DAYS = 365, FALLBACK_DAYS = 30;
const extractJson = (raw) => { const m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; } };
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

const PENDING_TITLE = /待确认是否仍有效|用户已确认仍有效|暂不执行·待复诊确认/;
const PENDING_GOAL = /先确认医嘱现在是否仍有效，再执行/;
const STALE_NOTE_G = /这是[^，。]{0,24}的医嘱，需确认是否仍有效。?/g;

function registerValidity(app, { db, findClient, planApi, appendLog, invalidateCheckin }) {
  const llm = (s, u, t) => mp.makeArkLlm({
    key: process.env.ARK_API_KEY, url: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    model: process.env.ARK_MODEL || process.env.SYNC_MODEL, extra: { thinking: { type: 'disabled' } },
  })(s, u, t);

  /** AI 估计“多久之后再提醒核对”。失败给保守默认，并如实记录原因。 */
  async function decideReview(active) {
    const items = active.items || [];
    const ref = (items.find((i) => i.origin && i.origin.ref_date) || {}).origin || {};
    const ageDays = ref.ref_date ? Math.max(0, Math.round((Date.now() - new Date(ref.ref_date + 'T00:00:00+08:00').getTime()) / DAY)) : null;
    const system = `你是健康管理助手。用户刚确认“这份医嘱现在仍然有效”。你不判断医嘱对不对，只估计：多少天后应该再提醒用户核对一次医嘱是否还有效。
考虑：病情性质（急性期/术后恢复期变化快 → 间隔短；稳定的慢性病长期方案 → 间隔可以长）、材料类型、材料已经多旧、医嘱里有没有写明复诊/复查时间（有的话不要超过那个时间）。
只输出 JSON：{"valid_days": 整数(${MIN_DAYS}~${MAX_DAYS}), "reason": "一句话说明依据，不得出现诊断结论"}`;
    const user = JSON.stringify({
      阶段: active.phase_title, 材料类型: ref.doc_type || '', 材料日期: ref.ref_date || '', 材料距今天数: ageDays,
      医嘱条目: items.slice(0, 14).map((i) => ({ 类别: i.line, 标题: clip(i.title, 40), 说明: clip(i.detail, 60) })),
    });
    try {
      const out = extractJson(await llm(system, user, 25000));
      const d = Math.round(Number(out && out.valid_days));
      if (!isFinite(d)) throw new Error('no valid_days');
      const days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, d));
      console.log(`[Validity] review decided days=${days} reason=${clip(out.reason, 60)}`);
      return { days, reason: clip(out.reason, 120), by: 'ai' };
    } catch (e) {
      console.error('[Validity] review decision failed, fallback:', e && e.message);
      return { days: FALLBACK_DAYS, reason: 'AI 评估未完成，按保守默认间隔提醒', by: 'fallback' };
    }
  }

  const stripPending = (plan, replaceWith) => ({
    phase_title: PENDING_TITLE.test(plan.phase_title || '') ? String(plan.phase_title).replace(PENDING_TITLE, replaceWith.title) : plan.phase_title,
    primary_goal: PENDING_GOAL.test(plan.primary_goal || '') || /已确认仍有效|待复诊确认/.test(plan.primary_goal || '') ? replaceWith.goal : plan.primary_goal,
  });

  const needClient = async (req, res) => { if (!await findClient(req.params.id)) { res.status(404).json({ error: '客户不存在' }); return false; } return true; };

  // 确认仍有效 / 暂不执行
  app.post('/api/clients/:id/plans/validity', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const id = req.params.id; const action = String((req.body || {}).action || '');
      if (!['valid', 'paused'].includes(action)) return res.status(400).json({ error: "action 必须是 valid 或 paused" });
      const active = await planApi.getActive(id);
      if (!active) return res.status(400).json({ error: '还没有生效的健康计划' });
      const now = Date.now(); const by = String((req.body || {}).by || 'user').slice(0, 20);
      let validity, titles;
      if (action === 'valid') {
        const rv = await decideReview(active);
        validity = { status: 'valid', confirmed_at: now, valid_until: now + rv.days * DAY, review_days: rv.days, review_reason: rv.reason, review_by: rv.by, by };
        titles = { title: '用户已确认仍有效', goal: '按您确认仍有效的医嘱执行（本计划只转述材料，不是诊断；以医生意见为准）' };
      } else {
        validity = { status: 'paused', at: now, by };
        titles = { title: '暂不执行·待复诊确认', goal: '您选择了先不执行这份医嘱，等复诊确认后再恢复；期间请以医生当面意见为准' };
      }
      const t = stripPending(active, titles);
      const items = (active.items || []).map((i) => ({ ...i, detail: String(i.detail || '').replace(STALE_NOTE_G, '').trim() }));
      const meta = { ...(active.meta || {}), validity };
      await db.query(`UPDATE llmwiki.plan_versions SET meta=$1, phase_title=$2, primary_goal=$3, items=$4 WHERE id=$5 AND status='active'`,
        [JSON.stringify(meta), t.phase_title, t.primary_goal, JSON.stringify(action === 'valid' ? items : active.items), active.id]);
      if (invalidateCheckin) invalidateCheckin(id);
      try {
        await appendLog(id, { id: `log_${now}_val`, type: 'wechat', title: action === 'valid' ? '计划事件：用户确认医嘱仍有效' : '计划事件：用户选择暂不执行医嘱',
          content: action === 'valid' ? `【计划事件】用户于 ${new Date(now + 8 * 3600000).toISOString().slice(0, 10)} 确认医嘱仍有效（来源：${by}；下次提醒约 ${validity.review_days} 天后）。仅记录用户声明，未改动任何医嘱内容。` : '【计划事件】用户选择暂不执行这份医嘱，待复诊确认。',
          created_at: now, synced: true });
      } catch (e) { console.error('[Validity] log failed:', e.message); }
      const plan = await planApi.getActive(id);
      console.log(`[Validity] ${id} action=${action} by=${by}`);
      res.json({ success: true, validity: validityState(plan), plan });
    } catch (err) { res.status(500).json({ error: '记录医嘱有效性失败: ' + err.message }); }
  });

  // 告诉 AI 哪些变了 → 待确认草稿（不直接生效）
  app.post('/api/clients/:id/plans/validity/revise', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const id = req.params.id; const text = clip((req.body || {}).text, 600);
      if (text.length < 2) return res.status(400).json({ error: '请先说明哪些变了' });
      const active = await planApi.getActive(id);
      if (!active) return res.status(400).json({ error: '还没有生效的健康计划' });
      const keys = new Set((active.items || []).map((i) => i.key));
      const system = `你把用户口述的“医嘱哪里变了”整理成对现有计划的修改。你只记录用户自己说的变化，不判断对错，不替医生决定，不添加用户没说的内容，不编造剂量。
输入给你：现有计划条目（key/类别/标题/说明）和用户的话。
输出 JSON：{"update":[{"key":"现有条目key","title":"新标题","detail":"新说明","stopped":false}],"remove":["现有条目key"],"add":[{"line":"diet|exercise|monitor|medication|environment","title":"","detail":""}],"unclear":"如果用户的话没有说清楚具体变了什么，写需要追问的一句话，否则空字符串"}
关键区分：“现有条目里已有的东西”发生变化（改剂量/次数/要求）一律用 update，不要用 add（add 只用于现有条目里完全没有的新东西）；用户说某条“停了/不用再吃/不再需要”→ 放 remove（或放 update 并把 stopped 设为 true），绝不能写成普通调整。
规则：update/remove 的 key 必须来自现有条目，同一个 key 不能同时出现在 update 和 remove；用户说“停了/不用再吃/不再需要”→ 只放 remove；用户说改了剂量/次数 → update，并保持用户原话中的数字。用户一句话里可能说了多处变化，要逐处都处理，不要漏。
重要：用户只说了变化的一部分（例如只说“改成每天两次”没说每次剂量）时，也必须输出 update：没提到的部分原样沿用现有条目里已有的内容（如每次剂量不变），只改用户说到的部分，并在 detail 里写明“每天两次（其余沿用原医嘱）”这类转述；不要因为缺少细节就跳过，也不要向用户追问现有条目里已经有的信息。只有完全无法对应到任何现有条目或新增内容时，才放进 unclear。`;
      const cur0 = (active.items || []).map((i) => ({ key: i.key, 类别: i.line, 标题: clip(i.title, 60), 说明: clip(i.detail, 120) }));
      // 稳定性：同一句话里有多处变化时，模型一次处理容易漏。先拆成“一句一个变化”，每个变化单独整理（并行），再合并
      let parts = [text];
      try {
        const sp = extractJson(await llm('把用户的话拆成“每句只含一个独立变化”的短句列表，保持原意和原数字，不增删内容。只输出 JSON：{"changes":["…","…"]}。只有一个变化就只输出一项。', text, 20000));
        if (sp && Array.isArray(sp.changes)) { const c = sp.changes.map((s) => clip(s, 200)).filter((s) => s.length >= 2).slice(0, 8); if (c.length) parts = c; }
      } catch (e) { console.error('[Validity] revise split failed (use whole):', e && e.message); }
      const runs = await Promise.all(parts.map(async (p) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try { const o = extractJson(await llm(system, JSON.stringify({ 现有条目: cur0, 用户的话: p }), 40000)); if (o) return o; } catch (e) { console.error('[Validity] revise llm failed:', e && e.message); }
        }
        return null;
      }));
      const okRuns = runs.filter(Boolean);
      console.log(`[Validity] revise parts=${parts.length} ok=${okRuns.length}`);
      if (!okRuns.length) return res.status(502).json({ error: 'AI 暂时没能整理，请稍后重试，或换成“上传最新材料”' });
      const arr = (k) => okRuns.flatMap((o) => (Array.isArray(o[k]) ? o[k] : []));
      const out = { update: arr('update'), remove: arr('remove'), add: arr('add'), unclear: okRuns.map((o) => o.unclear).filter(Boolean).join('；') };
      const unclear = clip(out.unclear, 120);
      const upd = Array.isArray(out.update) ? out.update : [], rem = Array.isArray(out.remove) ? out.remove : [], add = Array.isArray(out.add) ? out.add : [];
      const patch = []; const remove = [];
      const tag = '（用户自述变化，以医生处方为准）';
      const lcs = (a, b) => { let best = 0; const dp = Array(b.length + 1).fill(0); for (let i = 1; i <= a.length; i++) { let prev = 0; for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0; if (dp[j] > best) best = dp[j]; prev = tmp; } } return best; };
      for (const u of upd) {
        const k = String(u && u.key || ''); if (!keys.has(k)) continue;
        if (u.stopped === true) { remove.push(k); continue; } // 模型自己标注“已停”的，按移除处理，不能作为普通调整留着
        const cur = active.items.find((i) => i.key === k);
        const med = cur.line === 'medication';
        patch.push({ ...cur, title: clip(u.title, 80) || cur.title, detail: (clip(u.detail, 300) || cur.detail) + (med && !/以医生处方为准/.test(clip(u.detail, 300)) ? tag : ''), source: 'user' });
      }
      for (const k of rem) if (keys.has(String(k))) remove.push(String(k));
      for (let q = patch.length - 1; q >= 0; q--) if (remove.includes(patch[q].key)) patch.splice(q, 1); // 同一条既调整又移除：以移除为准
      for (let q = patch.length - 1; q >= 0; q--) if (remove.includes(patch[q].key)) patch.splice(q, 1); // 同一条既调整又移除：以移除为准
      let n = 1;
      for (const a of add) {
        if (!a || !['diet', 'exercise', 'monitor', 'medication', 'environment'].includes(a.line) || !clip(a.title, 80)) continue;
        // “新增”的名字和同类现有条目有≥ 4 个连续字相同 → 其实是对已有条目的修改，合并成 update，避免出现两条同名药
        const dup = active.items.find((i) => i.line === a.line && lcs(String(i.title), clip(a.title, 80)) >= 4 && !remove.includes(i.key));
        if (dup) {
          const at = patch.findIndex((p) => p.key === dup.key);
          const med = dup.line === 'medication';
          const merged = { ...dup, title: dup.title, detail: (clip(a.detail, 300) || clip(a.title, 300)) + (med ? tag : ''), source: 'user' };
          if (at >= 0) patch[at] = merged; else patch.push(merged);
          continue;
        }
        patch.push({ key: `user_${a.line}_${Date.now().toString(36)}${n++}`, line: a.line, title: clip(a.title, 80), detail: clip(a.detail, 300) + (a.line === 'medication' ? tag : ''), source: 'user' });
      }
      if (!patch.length && !remove.length) return res.json({ success: false, unclear: unclear || '没能从您的话里看出具体哪里变了，能再具体说说吗？（例如“XX药停了”“XX药改成每天两次”）' });
      const rv = await decideReview(active);
      const now = Date.now();
      const t = stripPending(active, { title: '用户已确认仍有效', goal: '按您更新后的医嘱执行（本计划只转述您提供的信息，不是诊断；以医生意见为准）' });
      const r = await planApi.createProposal(id, {
        source: 'user', proposed_by: 'user', reason: `用户自述医嘱有变化：${text.slice(0, 80)}`,
        items: patch, remove, phase_title: t.phase_title, primary_goal: t.primary_goal,
        meta: { kind: 'validity_revise', validity: { status: 'valid', confirmed_at: now, valid_until: now + rv.days * DAY, review_days: rv.days, review_reason: rv.reason, review_by: rv.by, by: 'revise' } },
      });
      if (r.code !== 201) return res.status(r.code).json(r.body);
      res.json({ success: true, proposal: r.body, unclear });
    } catch (err) { res.status(500).json({ error: '整理变化失败: ' + err.message }); }
  });
}

module.exports = { registerValidity };
