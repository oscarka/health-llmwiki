// 复现慢计划生成：长合成出院小结 -> from-text job，打印耗时。用 test_sandbox 客户并清理。
const BASE = process.env.BASE || 'https://llmwiki-yo5337ccva-an.a.run.app';
const drugs = ['阿司匹林肠溶片 100mg 每日1次 早餐后','氯吡格雷片 75mg 每日1次','阿托伐他汀钙片 20mg 每晚1次','缬沙坦胶囊 80mg 每日1次','二甲双胍缓释片 0.5g 每日2次 随餐','美托洛尔缓释片 47.5mg 每日1次','泮托拉唑肠溶片 40mg 每日1次 早餐前'];
let text = '出院小结\n入院日期：2024-12-20 出院日期：2025-01-02\n诊断：急性脑梗死（左侧基底节区），高血压3级，2型糖尿病，高脂血症。\n';
text += '住院经过：患者因突发右侧肢体无力伴言语不清入院，MRI示左侧基底节区急性梗死灶，予抗血小板、调脂、控制血压血糖、康复训练等治疗，症状好转出院。\n';
text += '化验：空腹血糖7.8mmol/L，LDL-C 3.1mmol/L，糖化血红蛋白7.6%，血压152/92mmHg。\n出院带药：\n' + drugs.map((d,i)=>`${i+1}. ${d}`).join('\n') + '\n';
text += '医嘱：\n';
for (let i=0;i<14;i++) text += `${i+1}）低盐低脂糖尿病饮食，每日盐<5g，控制碳水；规律康复训练，每日步行30分钟，患肢被动活动；监测血压血糖，每周复查；3个月后神经内科门诊复诊，查血脂肝功能。注意事项${i+1}：如出现头晕加重、言语不清立即就诊。\n`;
const j = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: {'content-type':'application/json'}, body: b ? JSON.stringify(b) : undefined }); let t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; } };
(async () => {
  const c = await j('POST', '/api/clients', { name: 'test_sandbox_slowplan' });
  const id = c.id; console.log('client', id, 'chars', text.length);
  const t0 = Date.now();
  const s = await j('POST', `/api/clients/${id}/plans/material/from-text`, { text, source: 'report' });
  console.log('submit', JSON.stringify(s).slice(0, 200));
  const jobId = s.job_id || s.jobId || s.id;
  for (;;) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await j('GET', `/api/clients/${id}/plans/material/jobs/${jobId}`);
    console.log(Math.round((Date.now()-t0)/1000)+'s', st.status, st.stage || '');
    if (st.status && st.status !== 'running' && st.status !== 'pending') { console.log(JSON.stringify(st).slice(0, 300)); break; }
    if (Date.now()-t0 > 420000) break;
  }
  console.log('client_for_cleanup', id);
})();
