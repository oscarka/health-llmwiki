// 本地调试：直接看 revise 提示词下模型的原始输出（不经线上服务）
require('dotenv').config({ path: '/Users/cc/llmwiki/.env' });
const mp = require('/Users/cc/llmwiki/health_plan/materialPlan.cjs');
const llm = (s, u, t) => mp.makeArkLlm({ key: process.env.ARK_API_KEY, url: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3', model: process.env.ARK_MODEL || process.env.SYNC_MODEL, extra: { thinking: { type: 'disabled' } } })(s, u, t);
const items = [
  { key: 'mat_medication_a1', line: 'medication', title: '服用阿司匹林肠溶片', detail: '每次100mg，每日1次。' },
  { key: 'mat_medication_a2', line: 'medication', title: '服用阿托伐他汀钙片', detail: '每次20mg，每晚1次。' },
  { key: 'mat_medication_a3', line: 'medication', title: '服用苯磺酸氨氯地平片', detail: '每次5mg，每日1次。' },
  { key: 'mat_diet_b1', line: 'diet', title: '低盐低脂饮食', detail: '' },
];
const system = `你把用户口述的“医嘱哪里变了”整理成对现有计划的修改。你只记录用户自己说的变化，不判断对错，不替医生决定，不添加用户没说的内容，不编造剂量。
输入给你：现有计划条目（key/类别/标题/说明）和用户的话。
输出 JSON：{"update":[{"key":"现有条目key","title":"新标题","detail":"新说明","stopped":false}],"remove":["现有条目key"],"add":[{"line":"diet|exercise|monitor|medication|environment","title":"","detail":""}],"unclear":"如果用户的话没有说清楚具体变了什么，写需要追问的一句话，否则空字符串"}
关键区分：“现有条目里已有的东西”发生变化（改剂量/次数/要求）一律用 update，不要用 add（add 只用于现有条目里完全没有的新东西）；用户说某条“停了/不用再吃/不再需要”→ 放 remove（或放 update 并把 stopped 设为 true），绝不能写成普通调整。
规则：update/remove 的 key 必须来自现有条目，同一个 key 不能同时出现在 update 和 remove；用户说“停了/不用再吃/不再需要”→ 只放 remove；用户说改了剂量/次数 → update，并保持用户原话中的数字。用户一句话里可能说了多处变化，要逐处都处理，不要漏；没说清楚的不要猜，放进 unclear。`;
const user = JSON.stringify({ 现有条目: items.map((i) => ({ key: i.key, 类别: i.line, 标题: i.title, 说明: i.detail })), 用户的话: '阿托伐他汀医生让停了，阿司匹林改成每天两次' });
(async () => { for (let n = 1; n <= 4; n++) console.log(`#${n}`, (await llm(system, user, 40000)).replace(/\s+/g, ' ').slice(0, 700)); })();
