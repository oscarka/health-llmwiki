// 情景摘要「大范围」测试：12 种不同处境 × (画像注入 + 打卡清单 + 饮食方案)，外加无情景对照。
// 用法: BASE=https://llmwiki-yo5337ccva-an.a.run.app node tests/broad_situation_rollout.cjs
// 全部用 test_sandbox_ 客户，测完删除。输出 tests/out/broad_situation_<ts>.json
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:5050';
const CONC = Number(process.env.CONC || 4);
const FORBIDDEN = /AI确诊|AI诊断为|人工智能诊断|confirmed by AI|AI confirms|AI判断|危及生命|life-threatening/;
const j = async (method, url, body, ms = 120000) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal }); return { s: r.status, b: await r.json().catch(() => ({})) }; }
  catch (e) { return { s: 0, b: { error: String(e.message || e) } }; } finally { clearTimeout(t); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// kw：该处境下，好的方案多半会体现的词（只用于统计“是否用上了情景”，不作为通过条件）
const SCEN = [
  { key: 'flight', age: 52, g: '男', allergy: '无', q: '最近有出远门吗?', a: '下周要坐飞机出差7天，白天在外开会', kw: ['出差', '航班', '外出', '便携', '外食', '旅途'] },
  { key: 'presurgery', age: 61, g: '女', allergy: '青霉素', q: '近期有什么安排?', a: '下个月初要住院做手术', kw: ['手术', '住院', '术前', '术后'] },
  { key: 'family_hip', age: 48, g: '女', allergy: '无', q: '家里有什么情况?', a: '我妈刚做完髋关节手术马上出院，我要照顾她', kw: ['照顾', '母亲', '家人', '陪护', '妈'] },
  { key: 'alone', age: 74, g: '男', allergy: '无', q: '住的情况?', a: '一个人住，做饭不方便，主要吃外卖和速食', kw: ['外卖', '速食', '一个人', '独居', '简单', '做饭'] },
  { key: 'nightshift', age: 39, g: '男', allergy: '无', q: '工作情况?', a: '长期上夜班，白天睡觉，吃饭时间不固定', kw: ['夜班', '作息', '睡', '时间'] },
  { key: 'moving', age: 55, g: '女', allergy: '花生', q: '最近生活有变化吗?', a: '下周要搬家，家里很乱，厨房暂时用不了', kw: ['搬家', '厨房', '外食', '简单', '打包'] },
  { key: 'canteen', age: 45, g: '女', allergy: '无', q: '三餐怎么吃?', a: '中午晚上都在单位食堂吃，自己不能选菜', kw: ['食堂', '单位', '选择', '搭配', '点'] },
  { key: 'travel_long', age: 67, g: '男', allergy: '无', q: '近期安排?', a: '下个月要去外地女儿家住两周，坐高铁', kw: ['高铁', '外地', '女儿', '旅途', '出行', '携带'] },
  { key: 'wheelchair', age: 70, g: '女', allergy: '无', q: '行动方面?', a: '刚做完膝关节手术，现在只能坐轮椅，下楼很困难', kw: ['轮椅', '行动', '上下楼', '康复', '膝', '坐'] },
  { key: 'caregiver_dm', age: 58, g: '女', allergy: '无', q: '家里情况?', a: '老伴刚查出糖尿病，我要学着给他做饭', kw: ['老伴', '做饭', '照顾', '家人', '控糖', '糖'] },
  { key: 'fasting', age: 50, g: '男', allergy: '无', q: '饮食上有什么习惯?', a: '最近在忙项目，经常一天只吃两顿，经常熬夜加班', kw: ['加班', '熬夜', '两顿', '规律', '定时', '三餐'] },
  { key: 'hospital_wait', age: 43, g: '女', allergy: '无', q: '近期要做什么?', a: '这周要去医院做胃镜，需要提前准备', kw: ['胃镜', '检查', '空腹', '禁食', '准备', '医院'] },
];

async function runOne(sc, withSituation) {
  const id = `test_sandbox_broad_${sc.key}_${withSituation ? 's' : 'c'}_${Date.now().toString(36).slice(-4)}`;
  const rec = { key: sc.key, control: !withSituation, id, checks: {}, notes: {} };
  const c = await j('POST', '/api/clients', { id, name: id, age: sc.age, gender: sc.g, allergies: sc.allergy });
  if (c.s >= 300) { rec.checks.created = false; rec.notes.err = JSON.stringify(c.b); return rec; }
  try {
    if (withSituation) {
      await j('POST', `/api/clients/${id}/plans/situation`, { submission_id: 's1', items: [{ question_id: 'q1', question: sc.q, options: [], answer_value: 'other', other_text: sc.a }] });
    }
    const pp = await j('GET', `/api/clients/${id}/plans/profile-preview`);
    const prof = String(pp.b.profile || '');
    rec.checks.profile_ok = withSituation ? (pp.b.situation_in_profile === true && /情景摘要/.test(prof) && /不是医嘱/.test(prof) && prof.length < 1700) : (!/情景摘要/.test(prof));
    rec.notes.profile_len = prof.length;

    const [ck, nu] = await Promise.all([
      j('GET', `/api/clients/${id}/plans/checkin?refresh=1`, undefined, 150000),
      (async () => {
        const g = await j('POST', `/api/clients/${id}/plans/nutrition/generate`, {});
        if (g.s !== 202) return { err: `generate ${g.s} ${JSON.stringify(g.b).slice(0, 100)}` };
        const jobId = g.b.jobId;
        for (let i = 0; i < 80; i++) {
          await sleep(4000);
          const jb = await j('GET', `/api/clients/${id}/plans/nutrition/jobs/${jobId}`);
          if (jb.b.status === 'done') return { nutrition: jb.b.nutrition, secs: jb.b.elapsed_s };
          if (jb.b.status === 'error') return { err: jb.b.error };
        }
        return { err: 'timeout' };
      })(),
    ]);
    const cb = ck.b || {};
    rec.checks.checkin_ok = ck.s === 200 && cb.generated_by && cb.generated_by.lifestyle === 'ai' && ((cb.diet || []).length + (cb.exercise || []).length + (cb.monitor || []).length) > 0;
    const ckText = JSON.stringify({ diet: cb.diet, exercise: cb.exercise, monitor: cb.monitor });
    rec.notes.checkin = { diet: (cb.diet || []).map((x) => x.title), exercise: (cb.exercise || []).map((x) => x.title), monitor: (cb.monitor || []).map((x) => x.title) };
    rec.checks.nutrition_ok = !!nu.nutrition && !nu.err;
    if (nu.err) rec.notes.nutrition_err = nu.err;
    let nuText = '';
    if (nu.nutrition) {
      const n = nu.nutrition;
      nuText = JSON.stringify(n);
      rec.checks.nutrition_review_ran = !!(n.review && n.review.ran);
      rec.checks.nutrition_no_violation = !!(n.review && n.review.remaining_violations === 0);
      rec.notes.nutrition_secs = nu.secs;
      rec.notes.nutrition_flags = n.flags || [];
      rec.notes.nutrition_head = nuText.slice(0, 600);
    }
    rec.checks.no_forbidden = !FORBIDDEN.test(ckText + nuText);
    if (withSituation) {
      const hit = sc.kw.filter((k) => (ckText + nuText).includes(k));
      rec.notes.uses_situation_kw = hit; rec.checks.uses_situation = hit.length > 0; // 信息项
    } else {
      const leak = sc.kw.filter((k) => (ckText + nuText).includes(k));
      rec.notes.control_kw = leak;
    }
  } catch (e) { rec.notes.exception = String(e.message || e); }
  finally { await j('DELETE', `/api/clients/${id}`); }
  return rec;
}

(async () => {
  const jobs = [];
  for (const sc of SCEN) { jobs.push([sc, true]); }
  // 对照：同样的年龄/性别，不写情景（挑 4 个）
  for (const sc of SCEN.slice(0, 4)) jobs.push([sc, false]);
  const results = []; let next = 0;
  const worker = async () => { while (next < jobs.length) { const [sc, ws] = jobs[next++]; const r = await runOne(sc, ws); results.push(r); const bad = Object.entries(r.checks).filter(([k, v]) => v === false).map(([k]) => k); console.log(`${r.control ? '对照' : '情景'} ${r.key}: ${bad.length ? '✗ ' + bad.join(',') : '✓'} (${(r.notes.uses_situation_kw || []).join('/')})`); } };
  await Promise.all(Array.from({ length: CONC }, worker));
  const hard = ['profile_ok', 'checkin_ok', 'nutrition_ok', 'nutrition_review_ran', 'nutrition_no_violation', 'no_forbidden'];
  const sums = {}; for (const k of [...hard, 'uses_situation']) { const rs = results.filter((r) => r.checks[k] !== undefined); sums[k] = `${rs.filter((r) => r.checks[k]).length}/${rs.length}`; }
  console.log('\n汇总', sums);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const f = path.join(__dirname, 'out', `broad_situation_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({ base: BASE, sums, results }, null, 2)); console.log('结果文件', f);
  process.exit(0);
})();
