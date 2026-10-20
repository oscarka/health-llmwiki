// 接口级重复测试：同一句“哪里变了”连测 4 次，看是否稳定、是否出现同一条既调整又移除
const WIKI = 'https://llmwiki-yo5337ccva-an.a.run.app';
const id = 'mini_199' + String(Date.now()).slice(-8) + '_user_self';
const d = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const TEXT = `某某医院 出院小结\n姓名：测试患者 性别：男 年龄：70岁 科室：神经内科\n入院日期：${d(660)} 出院日期：${d(650)}\n出院诊断：脑梗死恢复期；高血压病3级\n出院医嘱：1. 低盐低脂饮食；2. 每日监测血压；3. 1个月后神经内科复诊。\n出院带药：\n阿司匹林肠溶片 100mg 每日1次\n阿托伐他汀钙片 20mg 每晚1次\n苯磺酸氨氯地平片 5mg 每日1次\n医师：（略） ${d(650)}`;
const j = async (u, o) => { const r = await fetch(WIKI + u, o); let b = {}; try { b = await r.json(); } catch (e) { /* */ } return { s: r.status, b }; };
const post = (u, body) => j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
(async () => {
  await post('/api/clients', { id, name: '测试患者' });
  const g = await post(`/api/clients/${id}/plans/material/from-text`, { text: TEXT });
  let res; for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 3000)); const x = (await j(`/api/clients/${id}/plans/material/jobs/${g.b.jobId}`)).b; if (x.status === 'done') { res = x.result; break; } if (x.status === 'error') throw new Error(x.error); }
  await post(`/api/clients/${id}/plans/proposals/${res.proposal.id}/confirm`);
  for (let n = 1; n <= 6; n++) {
    const r = await post(`/api/clients/${id}/plans/validity/revise`, { text: '阿托伐他汀医生让停了，阿司匹林改成每天两次' });
    const ch = (r.b.proposal && r.b.proposal.changes || []).map((c) => `${c.op}:${(c.after || c.before).title}${c.op === 'update' ? '｜' + c.after.detail : ''}`);
    console.log(`#${n}`, r.s, JSON.stringify(ch));
    if (r.b.proposal) await post(`/api/clients/${id}/plans/proposals/${r.b.proposal.id}/reject`);
  }
  await fetch(`${WIKI}/api/clients/${id}`, { method: 'DELETE' });
  console.log('cleaned');
})().catch((e) => { console.log('ERR', e.message); fetch(`${WIKI}/api/clients/${id}`, { method: 'DELETE' }); });
