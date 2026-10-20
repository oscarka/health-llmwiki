// 情景摘要灰度读取测试。用法: BASE=http://localhost:5051 EXPECT=on node tests/test_situation_profile.cjs
// EXPECT=on  → 画像里应出现情景摘要;EXPECT=off → 画像与未开启时一致(不含情景摘要)
const BASE = process.env.BASE || 'http://localhost:5050';
const EXPECT = process.env.EXPECT || 'on';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const j = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, b: await r.json().catch(() => ({})) };
};
(async () => {
  const c = await j('POST', '/api/clients', { name: 'test_sandbox_situ_profile', age: 62, gender: '女' });
  const id = c.b.id;
  try {
    let r = await j('GET', `/api/clients/${id}/plans/profile-preview`);
    const before = r.b.profile;
    ok(r.s === 200 && /年龄：62/.test(before), '无情景档案时画像正常');
    ok(!/情景摘要/.test(before), '无情景档案时画像不含情景摘要');
    await j('POST', `/api/clients/${id}/plans/situation`, { submission_id: 's1', items: [{ question_id: 'q1', question: '最近有出远门吗?', options: [{ value: 'a', label: '要坐飞机' }], answer_value: 'a' }] });
    r = await j('GET', `/api/clients/${id}/plans/profile-preview`);
    if (EXPECT === 'on') {
      ok(r.b.situation_in_profile === true && /情景摘要.*要坐飞机/.test(r.b.profile), '开关命中:画像含情景摘要');
      ok(/仅供参考，不是医嘱/.test(r.b.profile), '情景摘要带"不是医嘱"标注');
    } else {
      ok(r.b.situation_in_profile === false && r.b.profile === before, '开关未命中:画像与原来逐字一致');
    }
    ok(r.b.profile.length < 1700, `画像长度可控(${r.b.profile.length})`);
  } finally {
    if (id) await j('DELETE', `/api/clients/${id}`);
  }
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
