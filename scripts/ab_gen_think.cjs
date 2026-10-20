// 生成+复核 A/B：推理档位 vs 耗时/质量。抄录一次（关思考）共用，生成+复核各档位并发跑 N 次。
require('/Users/cc/llmwiki/node_modules/dotenv').config({ path: '/Users/cc/llmwiki/.env' });
const mp = require('/Users/cc/llmwiki/health_plan/materialPlan.cjs');
const N = Number(process.env.N || 3);
const model = process.env.ARK_MODEL || process.env.SYNC_MODEL;
const cfg = { key: process.env.ARK_API_KEY, url: process.env.ARK_BASE_URL };
const te = (m) => (!m || m === 'default') ? undefined : (m === 'disabled' ? { thinking: { type: 'disabled' } } : { reasoning_effort: m });
const mk = (m) => mp.makeArkLlm({ ...cfg, model, extra: te(m) });
const drugs = ['阿司匹林', '氯吡格雷', '阿托伐他汀', '缬沙坦', '二甲双胍', '美托洛尔', '泮托拉唑'];
let text = '出院小结\n入院日期：2024-12-20 出院日期：2025-01-02\n诊断：急性脑梗死（左侧基底节区），高血压3级，2型糖尿病，高脂血症。\n住院经过：患者因突发右侧肢体无力伴言语不清入院，MRI示左侧基底节区急性梗死灶，予抗血小板、调脂、控制血压血糖、康复训练等治疗，症状好转出院。\n化验：空腹血糖7.8mmol/L，LDL-C 3.1mmol/L，糖化血红蛋白7.6%，血压152/92mmHg。\n出院带药：\n';
text += ['阿司匹林肠溶片 100mg 每日1次 早餐后', '氯吡格雷片 75mg 每日1次', '阿托伐他汀钙片 20mg 每晚1次', '缬沙坦胶囊 80mg 每日1次', '二甲双胍缓释片 0.5g 每日2次 随餐', '美托洛尔缓释片 47.5mg 每日1次', '泮托拉唑肠溶片 40mg 每日1次 早餐前'].map((d, i) => `${i + 1}. ${d}`).join('\n') + '\n医嘱：\n';
for (let i = 0; i < 14; i++) text += `${i + 1}）低盐低脂糖尿病饮食，每日盐<5g，控制碳水；规律康复训练，每日步行30分钟，患肢被动活动；监测血压血糖，每周复查；3个月后神经内科门诊复诊，查血脂肝功能。注意事项${i + 1}：如出现头晕加重、言语不清立即就诊。\n`;
const combos = (process.env.COMBOS || 'default/default,low/low,minimal/minimal,disabled/disabled').split(',').map((s) => s.split('/'));
(async () => {
  const raw = await mk('disabled')(mp.EXTRACT_PROMPT.replace(/图片/g, '文字'), `【文字】\n${text}`, 90000);
  const ex = mp.scrubPII(JSON.parse(raw.match(/\{[\s\S]*\}/)[0]));
  const conf = mp.confirmExtraction(ex, {});
  const one = async (g, r) => {
    const t = Date.now();
    try {
      const plan = await mp.generateMaterialPlan(conf, '2026-10-16', mk(g), { reviewLlm: mk(r) });
      const s = JSON.stringify(plan.items);
      const medHit = drugs.filter((d) => s.includes(d)).length;
      const m = plan.meta || {};
      return { ms: Date.now() - t, mode: plan.mode, gen: m.generated_by, att: m.attempts, items: plan.items.length, med: medHit, vio: (m.violations_history || []).length, rev: m.review ? (m.review.unavailable ? 'unavail' : 'ok') : '-', adds: m.added_by_program };
    } catch (e) { return { ms: Date.now() - t, err: e.message }; }
  };
  for (const [g, r] of combos) {
    const rs = await Promise.all(Array.from({ length: N }, () => one(g, r)));
    console.log(`\n#### 生成=${g} 复核=${r}`);
    rs.forEach((x) => console.log('  ' + (x.err ? 'ERR ' + x.err : `${Math.round(x.ms / 1000)}s mode=${x.mode} by=${x.gen} 尝试${x.att}次 条目${x.items} 药${x.med}/7 违规史${x.vio} 复核${x.rev} 程序补${x.adds}`)));
  }
})();
