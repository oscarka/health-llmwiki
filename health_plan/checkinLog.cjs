/**
 * 打卡记录（供 LLMWiki 展示）：用户在手机端的每次打卡/撤销，都以“事件”形式写到这里。
 *  - 一条事件 = 某天、某个打卡项（可带时段）当前是否已完成；同一天同一项重复点击是覆盖（幂等）。
 *  - 用 order_key 对应到生效计划里的条目，LLMWiki 的「健康计划」据此在每个条目旁显示：今日是否已打卡、近 7 天打卡天数；
 *    没有 order_key 的（通用建议）只出现在「打卡记录」时间线里。
 *  - 只记录用户自己的打卡动作，不做任何评价/诊断。
 */
const KINDS = ['med', 'diet', 'exercise', 'monitor'];
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (d) => new Date(d + 'T00:00:00Z').getTime();
const shiftDay = (d, n) => new Date(dayMs(d) + n * 86400000).toISOString().slice(0, 10);

function registerCheckinLog(app, { db, findClient, planApi }) {
  const ready = db.query(`CREATE TABLE IF NOT EXISTS llmwiki.plan_checkin_events (
    client_id TEXT NOT NULL, day TEXT NOT NULL, item_id TEXT NOT NULL, slot TEXT NOT NULL DEFAULT '',
    order_key TEXT, kind TEXT NOT NULL, title TEXT, done BOOLEAN NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY (client_id, day, item_id, slot))`, []).catch((e) => console.error('[CheckinLog] ensureTables failed:', e.message));

  app.post('/api/clients/:id/plans/checkin-events', async (req, res) => {
    try {
      await ready;
      if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' });
      const b = req.body || {};
      const day = String(b.day || '');
      if (!DAY_RE.test(day)) return res.status(400).json({ error: 'day 需为 YYYY-MM-DD' });
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      if (Math.abs(dayMs(day) - dayMs(today)) > 2 * 86400000) return res.status(400).json({ error: 'day 超出允许范围' });
      if (!KINDS.includes(b.kind)) return res.status(400).json({ error: `kind 必须是 ${KINDS.join('|')}` });
      const itemId = clip(b.item_id, 120); if (!itemId) return res.status(400).json({ error: 'item_id 必填' });
      const slot = clip(b.slot, 20);
      const orderKey = clip(b.order_key, 120) || null;
      await db.query(`INSERT INTO llmwiki.plan_checkin_events (client_id, day, item_id, slot, order_key, kind, title, done, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (client_id, day, item_id, slot) DO UPDATE SET done=EXCLUDED.done, title=EXCLUDED.title, order_key=EXCLUDED.order_key, updated_at=EXCLUDED.updated_at`,
      [req.params.id, day, itemId, slot, orderKey, b.kind, clip(b.title, 120), b.done !== false, Date.now()]);
      res.status(201).json({ success: true });
    } catch (e) { res.status(500).json({ error: '记录打卡失败: ' + e.message }); }
  });

  app.get('/api/clients/:id/plans/checkin-summary', async (req, res) => {
    try {
      await ready;
      if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' });
      const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
      const today = DAY_RE.test(String(req.query.today || '')) ? String(req.query.today) : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const from = shiftDay(today, -(days - 1));
      const rows = (await db.query(`SELECT day, item_id, slot, order_key, kind, title, done, updated_at FROM llmwiki.plan_checkin_events
        WHERE client_id=$1 AND day>=$2 AND day<=$3 ORDER BY updated_at DESC`, [req.params.id, from, today])).rows;
      const by_key = {};
      for (const r of rows) {
        if (!r.order_key) continue;
        const k = (by_key[r.order_key] = by_key[r.order_key] || { today_done: 0, today_undone: 0, done_days: new Set(), last_at: 0 });
        if (r.done) { k.done_days.add(r.day); if (r.day === today) k.today_done++; k.last_at = Math.max(k.last_at, Number(r.updated_at)); }
        else if (r.day === today) k.today_undone++;
      }
      for (const k of Object.keys(by_key)) by_key[k].done_days = by_key[k].done_days.size;
      const active = planApi && await planApi.getActive(req.params.id).catch(() => null);
      const sinceConfirm = active && active.confirmed_at ? Math.max(1, Math.floor((dayMs(today) - dayMs(new Date(Number(active.confirmed_at) + 8 * 3600000).toISOString().slice(0, 10))) / 86400000) + 1) : days;
      const timeline = [];
      for (const r of rows) {
        let d = timeline.find((x) => x.day === r.day);
        if (!d) { d = { day: r.day, events: [] }; timeline.push(d); }
        d.events.push({ kind: r.kind, title: r.title, slot: r.slot, done: r.done, at: Number(r.updated_at), order_key: r.order_key || null });
      }
      timeline.sort((a, b) => (a.day < b.day ? 1 : -1));
      res.json({ today, days, window_days: Math.min(days, sinceConfirm), by_key, timeline, total_events: rows.length });
    } catch (e) { res.status(500).json({ error: '读取打卡记录失败: ' + e.message }); }
  });

  // 删除客户时一并清理（供测试与客户删除用）
  return { clear: (id) => db.query(`DELETE FROM llmwiki.plan_checkin_events WHERE client_id=$1`, [id]).catch(() => {}) };
}

module.exports = { registerCheckinLog };
