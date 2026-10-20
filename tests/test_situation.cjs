// 情景档案契约测试(独立文件,不影响原 85 项测试)。用法: node tests/test_situation.cjs  (服务需先启动)
const BASE = process.env.BASE || 'http://localhost:5050';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const j = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, b: await r.json().catch(() => ({})) };
};
(async () => {
  const c = await j('POST', '/api/clients', { name: 'test_sandbox_situation' });
  const id = c.b.id;
  try {
    const items = [
      { question_id: 'q1', question: '最近有出远门吗?', options: [{ value: 'a', label: '没有' }, { value: 'plane', label: '要坐飞机' }], answer_value: 'plane' },
      { question_id: 'q2', question: '其他想说的', answer_value: '__other__', other_text: '怕在机场走不动' },
    ];
    let r = await j('POST', `/api/clients/${id}/plans/situation`, { submission_id: 's1', items });
    ok(r.s === 201, '保存返回201');
    ok(/要坐飞机/.test(r.b.summary) && /怕在机场走不动/.test(r.b.summary), '摘要含选项文字和用户原话');
    r = await j('POST', `/api/clients/${id}/plans/situation`, { submission_id: 's1', items });
    ok(r.s === 201, '同 submission_id 重复提交幂等');
    await j('POST', `/api/clients/${id}/plans/situation`, { submission_id: 's2', items: [items[0]] });
    r = await j('GET', `/api/clients/${id}/plans/situation`);
    ok(r.s === 200 && r.b.submissions.length === 2, '两次提交各自保留(共2份)');
    ok(r.b.submissions.some((x) => x.items.some((i) => i.other_text === '怕在机场走不动')), '原话原样保留');
    r = await j('POST', `/api/clients/${id}/plans/situation`, { items });
    ok(r.s === 400 && r.b.error, '缺 submission_id 返回400');
    r = await j('POST', `/api/clients/${id}/plans/situation`, { submission_id: 'x', items: [] });
    ok(r.s === 400, '空 items 返回400');
    r = await j('POST', `/api/clients/nope_${Date.now()}/plans/situation`, { submission_id: 'x', items });
    ok(r.s === 404, '客户不存在返回404');
  } finally {
    if (id) await j('DELETE', `/api/clients/${id}`);
  }
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
