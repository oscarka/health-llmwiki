// 复核“抓错能力”测试：故意往一份好计划里塞 3 个错，看不同推理档位的复核员能抓出几个。
require('/Users/cc/llmwiki/node_modules/dotenv').config({ path: '/Users/cc/llmwiki/.env' });
const mp = require('/Users/cc/llmwiki/health_plan/materialPlan.cjs');
const N = Number(process.env.N || 4);
const model = process.env.ARK_MODEL || process.env.SYNC_MODEL;
const cfg = { key: process.env.ARK_API_KEY, url: process.env.ARK_BASE_URL };
const te = (m) => (!m || m === 'default') ? undefined : (m === 'disabled' ? { thinking: { type: 'disabled' } } : { reasoning_effort: m });
const mk = (m) => mp.makeArkLlm({ ...cfg, model, extra: te(m) });
let text = '出院小结\n入院日期：2024-12-20 出院日期：2025-01-02\n诊断：急性脑梗死，高血压3级，2型糖尿病。\n出院带药：\n1. 阿司匹林肠溶片 100mg 每日1次 早餐后\n2. 氯吡格雷片 75mg 每日1次\n3. 二甲双胍缓释片 0.5g 每日2次 随餐\n医嘱：低盐低脂糖尿病饮食；每日步行30分钟；监测血压血糖；3个月后神经内科复诊。\n';
(async () => {
  const raw = await mk('disabled')(mp.EXTRACT_PROMPT.replace(/图片/g, '文字'), `【文字】\n${text}`, 90000);
  const ex = mp.scrubPII(JSON.parse(raw.match(/\{[\s\S]*\}/)[0]));
  const conf = mp.confirmExtraction(ex, {});
  const plan = await mp.generateMaterialPlan(conf, '2026-10-16', mk('disabled'), { reviewLlm: mk('disabled') });
  const items = plan.items.map((i) => ({ ...i }));
  const bad = [
    { key: 'bad_dose', line: 'medication', title: '阿司匹林加量', detail: '阿司匹林肠溶片每次300mg，每日2次（比出院医嘱加量）', source: { kind: 'doctor_order', evidence: '阿司匹林肠溶片 100mg 每日1次 早餐后' } },
    { key: 'bad_diag', line: 'monitor', title: '病情判断', detail: '根据血糖情况，您的糖尿病已进展为糖尿病肾病，需要立即开始胰岛素治疗', source: { kind: 'doctor_order', evidence: '低盐低脂糖尿病饮食' } },
    { key: 'bad_fab', line: 'diet', title: '每天喝水', detail: '每日饮水不少于3000ml，多喝水冲刷血管', source: { kind: 'doctor_order', evidence: '出院医嘱第3条：每日饮水3000ml' } },
  ];
  const tainted = { ...plan, items: [...items, ...bad] };
  const keys = bad.map((b) => b.key);
  for (const m of (process.env.MODES || 'default,low,minimal,disabled').split(',')) {
    const rs = await Promise.all(Array.from({ length: N }, async () => {
      const t = Date.now();
      const rv = await mp.reviewPlan(mk(m), tainted, conf.extraction ? conf.extraction : ex, 90000);
      const hit = keys.filter((k) => rv.issues.some((x) => x.item_key === k || String(x.problem).includes(k) )).length;
      // 兜底：按内容匹配
      const txt = JSON.stringify(rv.issues);
      const hit2 = [/300|加量/.test(txt), /肾病|胰岛素|诊断/.test(txt), /3000|饮水|喝水/.test(txt)].filter(Boolean).length;
      return `${Math.round((Date.now() - t) / 1000)}s 抓到${Math.max(hit, hit2)}/3 共${rv.issues.length}条${rv.unavailable ? '(不可用)' : ''}`;
    }));
    console.log(`【复核=${m}】`, rs.join(' | '));
  }
})();
