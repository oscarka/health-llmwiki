// 健康计划板块 API 测试（需本地服务 PORT=5051）。只使用 mini_199_ 命名空间的测试客户。
const BASE = process.env.BASE || 'http://localhost:5051';
const fs = require('fs');
const results = [];
let n = 0;
const rec = (name, ok, detail) => { n++; results.push({ no: n, name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}. ${name}${ok ? '' : ' → ' + detail}`); };
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j };
};
const item = (key, line, title, extra = {}) => ({ key, line, title, ...extra });

(async () => {
  const c = await api('POST', '/api/clients', { name: '计划测试_mini_199', age: 60, gender: '男' });
  const ghost = 'mini_199_ghost';
  let id;
  if (c.s !== 201) { console.log('create client failed', c); process.exit(1); }
  id = c.j.id;
  const out = { client: id };
  try {
    let r = await api('GET', `/api/clients/${ghost}/plans`);
    rec('未知客户返回 404', r.s === 404, r.s);

    r = await api('GET', `/api/clients/${id}/plans`);
    rec('新客户无计划：active=null，无草稿，无历史', r.s === 200 && r.j.active === null && r.j.drafts.length === 0 && r.j.history.length === 0, JSON.stringify(r.j));

    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '首次', items: [] });
    rec('首次计划不给 items → 400', r.s === 400, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { items: [item('diet.water', 'diet', '饮水')] });
    rec('缺 reason → 400', r.s === 400, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: 'x', items: [item('Bad Key', 'diet', '饮水')] });
    rec('非法 key → 400', r.s === 400, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: 'x', items: [item('diet.water', 'sleep', '饮水')] });
    rec('非法 line → 400', r.s === 400, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: 'x', items: [item('diet.water', 'diet', '饮水', { target: { comparator: 'bigger', value: 1 } })] });
    rec('非法 comparator → 400', r.s === 400, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: 'x', items: [item('diet.water', 'diet', '饮水', { target: { comparator: 'between', min: 5, max: 1 } })] });
    rec('between min>max → 400', r.s === 400, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: 'x', source: 'alien', items: [item('diet.water', 'diet', '饮水')] });
    rec('非法 source → 400', r.s === 400, r.s);

    // v1
    const v1items = [
      item('diet.water', 'diet', '每日饮水', { detail: '分次饮用', target: { metric: 'water', comparator: 'gte', value: 2000, unit: 'ml' }, binding: { kind: 'ledger', recordKind: 'water' } }),
      item('diet.meat', 'diet', '午餐主荤：牛腩', { detail: '每周周二' }),
      item('exercise.walk', 'exercise', '快走', { target: { metric: 'walk_minutes', comparator: 'gte', value: 30, unit: '分钟', period: 'day' }, binding: { kind: 'manual' } }),
      item('monitor.bp', 'monitor', '早晚测血压', { target: { metric: 'bp_count', comparator: 'count_gte', value: 2, unit: '次' }, binding: { kind: 'ledger', recordKind: 'bp' } }),
      item('medication.amlodipine', 'medication', '氨氯地平 每日一次'),
    ];
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '康复出院后的基础计划', proposed_by: 'system', phase_title: '康复期第1阶段', primary_goal: '血压稳定、体重下降', items: v1items });
    const p1 = r.j;
    rec('创建 v1 提案 → 201 draft，版本号未定', r.s === 201 && p1.status === 'draft' && p1.version === null && p1.base_version === 0, JSON.stringify(r.j).slice(0, 200));
    r = await api('GET', `/api/clients/${id}/plans`);
    rec('草稿不算生效：active 仍为空，drafts=1', r.j.active === null && r.j.drafts.length === 1, '');
    r = await api('GET', `/api/clients/${id}/plans/active`);
    rec('草稿阶段 summary 为空（管家看不到未确认内容）', r.j.summary === '', r.j.summary);

    r = await api('POST', `/api/clients/${id}/plans/proposals/${p1.id}/confirm`);
    rec('确认 v1 → 生效 version=1', r.s === 200 && r.j.plan.version === 1 && r.j.plan.status === 'active', JSON.stringify(r.j).slice(0, 200));
    out.summary_v1 = r.j.summary;
    r = await api('POST', `/api/clients/${id}/plans/proposals/${p1.id}/confirm`);
    rec('重复确认 → 409', r.s === 409, r.s);

    // v2 : 营养师改饮水 + 换牛腩 + 新增
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '营养师评估：肾功能偏弱，限水并去牛羊肉', proposed_by: 'nutritionist', source: 'nutritionist', items: [
      item('diet.water', 'diet', '每日饮水', { detail: '分次饮用', target: { metric: 'water', comparator: 'gte', value: 1700, unit: 'ml' }, binding: { kind: 'ledger', recordKind: 'water' } }),
      item('diet.meat', 'diet', '午餐主荤：鸡丁'),
      item('diet.salt', 'diet', '每日盐摄入', { target: { metric: 'salt', comparator: 'lte', value: 5, unit: 'g' } }),
    ] });
    const p2 = r.j;
    const ops = (p2.changes || []).map((x) => `${x.op}:${x.key}`).sort().join(',');
    rec('v2 提案 diff 正确（改饮水/改荤菜/增盐，其余不动）', r.s === 201 && ops === 'add:diet.salt,update:diet.meat,update:diet.water' && p2.base_version === 1, ops);
    // 同时第二个草稿（将来会过期）
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '另一个调整', proposed_by: 'user', source: 'user', items: [item('exercise.walk', 'exercise', '快走', { target: { metric: 'walk_minutes', comparator: 'gte', value: 20, unit: '分钟' } })] });
    const p3 = r.j;
    rec('可并存多个草稿', r.s === 201, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '无变化', items: [item('diet.salt', 'diet', '每日盐摄入')] });
    rec('（v1 基础上）与生效计划完全一致的提案：仍有变化(新增盐)，不应400', r.s === 201, r.s);
    const pTmp = r.j;
    await api('POST', `/api/clients/${id}/plans/proposals/${pTmp.id}/reject`);

    r = await api('POST', `/api/clients/${id}/plans/proposals/${p2.id}/confirm`);
    rec('确认 v2 → version=2，来源营养师', r.s === 200 && r.j.plan.version === 2 && r.j.plan.source === 'nutritionist', JSON.stringify(r.j).slice(0, 150));
    out.summary_v2 = r.j.summary;
    r = await api('GET', `/api/clients/${id}/plans`);
    const actives = r.j.history.filter((h) => h.status === 'active');
    const sup = r.j.history.filter((h) => h.status === 'superseded');
    rec('同一时刻只有 1 个生效，v1 变已取代', actives.length === 1 && actives[0].version === 2 && sup.length === 1 && sup[0].version === 1, JSON.stringify(r.j.history.map((h) => [h.version, h.status])));
    rec('生效计划里饮水=1700、牛腩已换、盐新增、血压/用药保留', (() => { const m = Object.fromEntries(r.j.active.items.map((i) => [i.key, i])); return m['diet.water'].target.value === 1700 && m['diet.meat'].title.includes('鸡丁') && m['diet.salt'] && m['monitor.bp'] && m['medication.amlodipine']; })(), '');
    rec('基于旧版本的草稿自动失效，不留待确认', r.j.drafts.length === 0, JSON.stringify(r.j.drafts.map((d) => d.status)));

    r = await api('POST', `/api/clients/${id}/plans/proposals/${p3.id}/confirm`);
    rec('确认已过期草稿 → 409', r.s === 409, r.s);

    // 过时提案：基于 v2 创建 pA、pB；确认 pA 后 pB 过期（走 stale 通路：直接确认 pB）
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '运动调整A', source: 'user', proposed_by: 'user', items: [item('exercise.walk', 'exercise', '快走', { target: { metric: 'walk_minutes', comparator: 'gte', value: 20, unit: '分钟' } })] });
    const pA = r.j;
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '运动调整B', source: 'doctor', proposed_by: 'doctor', items: [item('exercise.walk', 'exercise', '快走', { target: { metric: 'walk_minutes', comparator: 'gte', value: 45, unit: '分钟' } })] });
    const pB = r.j;
    r = await api('POST', `/api/clients/${id}/plans/proposals/${pA.id}/confirm`);
    rec('确认 pA → v3', r.s === 200 && r.j.plan.version === 3, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals/${pB.id}/confirm`);
    rec('另一个同期提案 pB 确认 → 409（已失效，防新旧冲突）', r.s === 409, r.s);

    // 移除
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '停用盐限制测试', remove: ['diet.salt', 'nonexistent.key'] });
    rec('移除提案：只对存在的 key 生成 remove', r.s === 201 && r.j.changes.length === 1 && r.j.changes[0].op === 'remove', JSON.stringify(r.j.changes));
    const pR = r.j;
    r = await api('POST', `/api/clients/${id}/plans/proposals/${pR.id}/reject`);
    rec('拒绝提案 → 200', r.s === 200, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals/${pR.id}/reject`);
    rec('重复拒绝 → 404', r.s === 404, r.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '没变化', remove: ['nonexistent.key'] });
    rec('没有任何变化的提案 → 400', r.s === 400, r.s);

    // 历史
    r = await api('GET', `/api/clients/${id}/plans/versions/1`);
    rec('历史版本 v1 全文可读且饮水仍为 2000（旧值保留）', r.s === 200 && r.j.items.find((i) => i.key === 'diet.water').target.value === 2000, r.s);
    r = await api('GET', `/api/clients/${id}/plans/versions/99`);
    rec('不存在的版本 → 404', r.s === 404, r.s);
    r = await api('GET', `/api/clients/${id}/plans/versions/3`);
    out.v3_changes = r.j.changes;

    // 档案事件
    r = await api('GET', `/api/clients/${id}/logs`);
    const evts = (Array.isArray(r.j) ? r.j : []).filter((l) => (l.content || '').startsWith('【计划事件】'));
    rec('档案留下 3 条计划事件（v1/v2/v3）', evts.length === 3, evts.length);
    rec('档案事件只记事实，不含计划正文（无"午餐主荤"明细/ml 数值目标）', evts.every((e) => !e.content.includes('分次饮用') && !e.content.includes('target')), '');
    out.events = evts.map((e) => e.content);

    // context-inject
    r = await api('GET', `/api/clients/${id}/context-inject`);
    rec('context-inject 带 health_plan 摘要（v3）', r.s === 200 && /v3/.test(r.j.health_plan || '') && /1700/.test(r.j.health_plan), JSON.stringify(r.j).slice(0, 200));
    out.context_plan = r.j.health_plan;
    r = await api('GET', `/api/clients/${id}/wiki`);
    rec('计划正文不进档案 Wiki 页面', r.s === 200 && !JSON.stringify(r.j).includes('每日饮水'), '');
  } finally {
    const d = await api('DELETE', `/api/clients/${id}`);
    rec('删除客户后计划数据一并清除', d.s === 200, d.s);
    const r = await api('GET', `/api/clients/${id}/plans`);
    rec('删除后读取计划 → 404', r.s === 404, r.s);
  }
  out.results = results;
  fs.mkdirSync(__dirname + '/out', { recursive: true });
  fs.writeFileSync(__dirname + '/out/health_plan_api_results.json', JSON.stringify(out, null, 2));
  const fail = results.filter((x) => !x.ok).length;
  console.log(`\n共 ${results.length} 项，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
