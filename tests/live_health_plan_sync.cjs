// 线上验证：①老功能不退化 ②计划事件经 AI 同步后写进 Wiki 的效果（报告第 4 个未验证项）
const BASE = process.env.BASE || 'https://llmwiki-yo5337ccva-an.a.run.app';
const fs = require('fs');
const api = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
const res = [];
const rec = (n, ok, d) => { res.push({ n, ok: !!ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' → ' + d}`); };
(async () => {
  const out = {};
  let r = await api('GET', '/api/clients');
  rec('老接口：客户列表 200 且为数组', r.s === 200 && Array.isArray(r.j), r.s);
  const c = await api('POST', '/api/clients', { name: '计划同步测试_mini_199', age: 63, gender: '男' });
  const id = c.j.id;
  try {
    r = await api('GET', `/api/clients/${id}/service-permissions`);
    rec('老接口：服务权限 200', r.s === 200, r.s);
    r = await api('GET', `/api/clients/${id}/wiki`);
    rec('老接口：Wiki 页面 200 且含 5 个标准页', r.s === 200 && ['index.md', 'medical_history.md', 'medication_plan.md', 'communication_timeline.md'].every((k) => r.j[k]), Object.keys(r.j || {}));

    // 一条真实沟通 + 一份计划
    r = await api('POST', `/api/clients/${id}/logs`, { type: 'phone', title: '电话随访', content: '[患者] 最近早上血压 148/92，有点头晕。[健康管理师] 请按时服用氨氯地平，每天早晚各量一次血压并记录，饮食低盐。' });
    rec('录入沟通日志 201', r.s === 201, r.s);
    const p = await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '线上测试：出院后基础计划', proposed_by: 'system', phase_title: '康复期 · 第 1 阶段', primary_goal: '血压稳定在 130/80 以下', items: [
      { key: 'diet.water', line: 'diet', title: '每日饮水', detail: 'PLANBODY_MARK_每日饮水2000ml分次喝', target: { metric: 'water', comparator: 'gte', value: 2000, unit: 'ml' } },
      { key: 'exercise.walk', line: 'exercise', title: '快走', detail: 'PLANBODY_MARK_饭后一小时快走' },
    ] });
    rec('线上创建提案 201', p.s === 201, p.s);
    r = await api('POST', `/api/clients/${id}/plans/proposals/${p.j.id}/confirm`);
    rec('线上确认 v1', r.s === 200 && r.j.plan.version === 1, r.s);

    r = await api('POST', `/api/clients/${id}/sync`, {});
    rec('触发 AI 同步（含计划事件日志）', r.s === 200, JSON.stringify(r.j).slice(0, 200));
    out.sync = r.j;
    r = await api('GET', `/api/clients/${id}/wiki`);
    const all = JSON.stringify(r.j);
    out.wiki_has_plan_event_text = /计划事件|健康计划 v1|健康计划.*v1/.test(all);
    out.wiki_has_plan_body_marker = all.includes('PLANBODY_MARK');
    rec('计划正文标记没有泄漏进 Wiki 页面', !out.wiki_has_plan_body_marker, 'PLANBODY_MARK 出现在 Wiki');
    rec('同步后 Wiki 记录了血压/头晕等真实沟通内容', /148\/92/.test(all), '未写入 148/92');
    const logs = await api('GET', `/api/clients/${id}/logs`);
    out.logs_synced = (logs.j || []).map((l) => ({ title: l.title, synced: l.synced }));
    out.wiki_pages_snapshot = r.j;
    out.plan_event_mentions = [];
    for (const [k, v] of Object.entries(r.j)) { const ms = String(v).split('\n').filter((l) => /计划事件|健康计划/.test(l)); if (ms.length) out.plan_event_mentions.push({ page: k, lines: ms.slice(0, 5) }); }
    rec('计划事件没有被 AI 误写成 Wiki 里的"干预措施"', out.plan_event_mentions.length === 0, JSON.stringify(out.plan_event_mentions));
    rec('计划事件日志仍可在原始日志里查到', (logs.j || []).some((l) => /计划事件/.test(l.title || '') ), '');
    r = await api('GET', `/api/clients/${id}/context-inject`);
    rec('context-inject 带生效计划摘要，且不含 Wiki 以外正文泄漏标记', /v1/.test(r.j.health_plan || '') && r.s === 200, JSON.stringify(r.j).slice(0, 150));
    out.context_plan = r.j.health_plan;
  } finally {
    const d = await api('DELETE', `/api/clients/${id}`);
    rec('清理测试客户', d.s === 200, d.s);
  }
  out.results = res;
  fs.mkdirSync(__dirname + '/out', { recursive: true });
  fs.writeFileSync(__dirname + '/out/live_sync_check.json', JSON.stringify(out, null, 2));
  console.log('\n计划事件在 Wiki 里的出现：', JSON.stringify(out.plan_event_mentions));
  console.log('失败项：', res.filter((x) => !x.ok).length);
})();
