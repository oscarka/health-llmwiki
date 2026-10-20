// 抄录步骤 A/B：推理档位 vs 耗时/token/忠实度。忠实度=7种药的名称+剂量+频次是否都抄到；医嘱条数。
require('/Users/cc/llmwiki/node_modules/dotenv').config({ path: '/Users/cc/llmwiki/.env' });
const mp = require('/Users/cc/llmwiki/health_plan/materialPlan.cjs');
const N = Number(process.env.N || 3);
const drugs = [['阿司匹林','100','1'],['氯吡格雷','75','1'],['阿托伐他汀','20','1'],['缬沙坦','80','1'],['二甲双胍','0.5','2'],['美托洛尔','47.5','1'],['泮托拉唑','40','1']];
let text = '出院小结\n入院日期：2024-12-20 出院日期：2025-01-02\n诊断：急性脑梗死（左侧基底节区），高血压3级，2型糖尿病，高脂血症。\n住院经过：患者因突发右侧肢体无力伴言语不清入院，MRI示左侧基底节区急性梗死灶，予抗血小板、调脂、控制血压血糖、康复训练等治疗，症状好转出院。\n化验：空腹血糖7.8mmol/L，LDL-C 3.1mmol/L，糖化血红蛋白7.6%，血压152/92mmHg。\n出院带药：\n';
text += ['阿司匹林肠溶片 100mg 每日1次 早餐后','氯吡格雷片 75mg 每日1次','阿托伐他汀钙片 20mg 每晚1次','缬沙坦胶囊 80mg 每日1次','二甲双胍缓释片 0.5g 每日2次 随餐','美托洛尔缓释片 47.5mg 每日1次','泮托拉唑肠溶片 40mg 每日1次 早餐前'].map((d,i)=>`${i+1}. ${d}`).join('\n') + '\n医嘱：\n';
for (let i=0;i<14;i++) text += `${i+1}）低盐低脂糖尿病饮食，每日盐<5g，控制碳水；规律康复训练，每日步行30分钟，患肢被动活动；监测血压血糖，每周复查；3个月后神经内科门诊复诊，查血脂肝功能。注意事项${i+1}：如出现头晕加重、言语不清立即就诊。\n`;
const extractJson = (t) => { const m = String(t).match(/\{[\s\S]*\}/); try { return JSON.parse(m[0]); } catch { return null; } };
const modes = [['默认(推理开)', undefined], ['reasoning_effort=low', { reasoning_effort: 'low' }], ['reasoning_effort=minimal', { reasoning_effort: 'minimal' }], ['推理关', { thinking: { type: 'disabled' } }]];
async function one(extra) {
  const llm = mp.makeArkLlm({ key: process.env.ARK_API_KEY, url: process.env.ARK_BASE_URL, model: process.env.ARK_MODEL || process.env.SYNC_MODEL, extra });
  const t = Date.now();
  try {
    const raw = await llm(mp.EXTRACT_PROMPT.replace(/图片/g, '文字'), `【文字】\n${text}`, 150000);
    const j = extractJson(raw); const s = JSON.stringify(j || {});
    const medOk = drugs.filter(([n, d, f]) => s.includes(n) && s.includes(d)).length;
    return { ms: Date.now() - t, parsed: !!j, medOk, chars: s.length };
  } catch (e) { return { ms: Date.now() - t, err: e.message }; }
}
(async () => {
  for (const [name, extra] of modes) {
    const rs = await Promise.all(Array.from({ length: N }, () => one(extra)));
    console.log(`【${name}】`, rs.map((r) => r.err ? 'ERR:' + r.err : `${Math.round(r.ms / 1000)}s 药${r.medOk}/7 chars${r.chars}`).join(' | '));
  }
})();
