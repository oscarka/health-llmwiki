/**
 * 情景档案：建档时用户回答的“情景问答”原样存档，跟着这个人走。
 *  - 一次提交 = 一份档案（带 submission_id，同一份重复提交是覆盖，幂等）；多次提交保留历史，不互相覆盖。
 *  - 问题、选项、用户选择、“其他情况”原话全部原样保留，不让 AI 改写。
 *  - summary 由程序把“问题：回答”拼起来（不调用 AI），供以后方案/饮食/打卡读取。
 *  - 纯新增：新表、新接口，不改任何已有表/接口。
 */
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function buildSummary(items) {
  return items
    .map((it) => `${it.question}：${it.answer_text}`)
    .filter((l) => l.length > 2)
    .join('；')
    .slice(0, 800);
}

function normalizeItems(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const r of raw.slice(0, 30)) {
    if (!r || typeof r !== 'object') continue;
    const question = clip(r.question, 300);
    if (!question) continue;
    const options = Array.isArray(r.options)
      ? r.options.slice(0, 20).map((o) => ({ value: clip(o && o.value, 80), label: clip(o && o.label, 200) }))
      : [];
    const answerValue = clip(r.answer_value, 200);
    const otherText = clip(r.other_text, 500);
    const picked = options.find((o) => o.value === answerValue);
    const answerText = otherText || clip(r.answer_text, 500) || (picked && picked.label) || answerValue;
    out.push({
      question_id: clip(r.question_id, 80),
      question,
      options,
      answer_value: answerValue,
      other_text: otherText,
      answer_text: answerText,
    });
  }
  return out.length ? out : null;
}

function registerSituation(app, { db, findClient }) {
  const ready = db.query(`CREATE TABLE IF NOT EXISTS llmwiki.client_situation (
    client_id TEXT NOT NULL, submission_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'onboarding',
    items JSONB NOT NULL, summary TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL,
    PRIMARY KEY (client_id, submission_id))`, []).catch((e) => console.error('[Situation] ensureTables failed:', e.message));

  app.post('/api/clients/:id/plans/situation', async (req, res) => {
    try {
      await ready;
      if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' });
      const b = req.body || {};
      const submissionId = clip(b.submission_id, 80);
      if (!submissionId) return res.status(400).json({ error: 'submission_id 必填' });
      const items = normalizeItems(b.items);
      if (!items) return res.status(400).json({ error: 'items 必须是非空数组，且每项含 question' });
      const summary = buildSummary(items);
      await db.query(`INSERT INTO llmwiki.client_situation (client_id, submission_id, source, items, summary, created_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (client_id, submission_id) DO UPDATE SET items=EXCLUDED.items, summary=EXCLUDED.summary, source=EXCLUDED.source`,
      [req.params.id, submissionId, clip(b.source, 40) || 'onboarding', JSON.stringify(items), summary, Date.now()]);
      res.status(201).json({ success: true, submission_id: submissionId, summary });
    } catch (e) { res.status(500).json({ error: '保存情景档案失败: ' + e.message }); }
  });

  app.get('/api/clients/:id/plans/situation', async (req, res) => {
    try {
      await ready;
      if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' });
      const rows = (await db.query(`SELECT submission_id, source, items, summary, created_at FROM llmwiki.client_situation
        WHERE client_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.params.id])).rows;
      res.json({ latest_summary: rows[0] ? rows[0].summary : '', submissions: rows.map((r) => ({ ...r, created_at: Number(r.created_at) })) });
    } catch (e) { res.status(500).json({ error: '读取情景档案失败: ' + e.message }); }
  });

  // 聊天里出现的新情况：追加一份带日期的档案（原话保留，不覆盖历史）；摘要 = 之前最新摘要 + 这条新情况，供方案/饮食/打卡读取
  app.post('/api/clients/:id/plans/situation/note', async (req, res) => {
    try {
      await ready;
      if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' });
      const text = clip((req.body || {}).text, 300);
      if (!text) return res.status(400).json({ error: 'text 必填（用户原话）' });
      const d = new Date(Date.now() + 8 * 3600 * 1000);
      const stamp = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const prev = (await db.query('SELECT summary FROM llmwiki.client_situation WHERE client_id=$1 ORDER BY created_at DESC LIMIT 1', [req.params.id])).rows[0];
      const item = { question_id: 'chat_note', question: `聊天中提到的新情况（${stamp}）`, options: [], answer_value: '', other_text: text, answer_text: text };
      let summary = [prev && prev.summary, `${item.question}：${text}`].filter(Boolean).join('；');
      if (summary.length > 800) summary = summary.slice(-800);
      const submissionId = `chat_${Date.now().toString(36)}`;
      await db.query(`INSERT INTO llmwiki.client_situation (client_id, submission_id, source, items, summary, created_at) VALUES ($1,$2,'ai_chat',$3,$4,$5)`,
        [req.params.id, submissionId, JSON.stringify([item]), summary, Date.now()]);
      res.status(201).json({ success: true, submission_id: submissionId, summary });
    } catch (e) { res.status(500).json({ error: '追加情景档案失败: ' + e.message }); }
  });

  return { clear: (id) => db.query(`DELETE FROM llmwiki.client_situation WHERE client_id=$1`, [id]).catch(() => {}) };
}

module.exports = { registerSituation };
