/**
 * 审核台新功能测试：医生修改出处/免责声明（保存 / 修改并通过）、打回重做（AI 按意见重新生成）。
 * 用法：TEST_BASE_URL=... WIDGET_REVIEW_TOKEN=... node tests/test_widget_review_edit.cjs
 * 只用 test_sandbox_* 数据；结束后清理，并把审核模式恢复成测试前的值。
 */
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5071';
const TOKEN = process.env.WIDGET_REVIEW_TOKEN || '';
const H = { 'Content-Type': 'application/json', 'x-review-token': TOKEN };
const j = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); let d = {}; try { d = await r.json(); } catch (e) { /* */ } return { s: r.status, d }; };
let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); };
const sfx = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASS = { verdict: 'pass', scope: '办事', reasons: '审核台修改/打回测试' };

const spec = (key, name, constants) => ({
  id: key, name, kind: '计算器', scenario_key: key,
  trigger: { when: '用户自述近期要坐飞机出差，需要决定药怎么分装带' },
  inputs: [{ key: 'days', label: '要出门几天', type: 'number', default: 3 }],
  program: '随身包放出门天数的药，另按天数加 2 天备用',
  program_code: 'function main(inputs){var d=Number(inputs["days"])||0;return {"随身包必须带的天数":(d+2)+"天的量","提醒":"每天要吃的药放随身包"};}',
  output: '随身包里放几天的药', content: [{ title: '出发前', items: ['药盒分装', '带上处方复印件', '记下目的地医院'] }],
  disclaimer: '仅为出行准备参考，具体用药请遵医嘱', constants, sources: ['行李安排，无固定医学常数'], not_do: ['不改药量'],
});

(async () => {
  const created = []; const clients = []; let origMode = null;
  try {
    const st = await j('GET', '/api/widgets/admin/settings');
    ok('审核口令有效', st.s === 200);
    origMode = st.d.review_mode;
    await j('PUT', '/api/widgets/admin/settings', { review_mode: 'manual' });

    // 1 常数出处待确认 → 进入待审核
    const k1 = `test_sandbox_edit_${sfx}`;
    const d1 = await j('POST', '/api/widgets/admin/drafts', { spec: spec(k1, `test_sandbox 修改出处 ${sfx}`, [{ value: '备用多留 2 天', source: 'pending_review' }]), why: '测试', disease_label: '测试病种', judge_override: PASS });
    created.push(d1.d.toolId);
    ok('常数出处待确认的工具进入待审核，且标记“需人工确认”', d1.d.toolStatus === 'pending_review' && (d1.d.lint.human || []).length === 1, JSON.stringify(d1.d.lint.human));

    // 2 修改：非法输入被拒
    let r = await j('POST', `/api/widgets/admin/tools/${d1.d.toolId}/edit`, { reviewer: '测试医生', constants: [{ idx: 0, source: 'https://example.com/guide' }] });
    ok('出处贴网址被拒(400)', r.s === 400, r.d.error);
    r = await j('POST', `/api/widgets/admin/tools/${d1.d.toolId}/edit`, { reviewer: '测试医生', constants: [{ idx: 5, source: '某指南' }] });
    ok('不存在的常数序号被拒(400)', r.s === 400, r.d.error);
    r = await j('POST', `/api/widgets/admin/tools/${d1.d.toolId}/edit`, { reviewer: '测试医生', constants: [{ idx: 0, source: '' }] });
    ok('出处为空被拒(400)', r.s === 400, r.d.error);
    r = await j('POST', `/api/widgets/admin/tools/${d1.d.toolId}/edit`, { reviewer: '测试医生', disclaimer: '请遵医嘱，AI确诊为本病' });
    ok('改出禁用表述的免责声明被自动检查拦住(400)', r.s === 400, r.d.error);

    // 3 保存修改（不通过）：状态仍待审核，“需人工确认”清空，历史有记录
    r = await j('POST', `/api/widgets/admin/tools/${d1.d.toolId}/edit`, { reviewer: '测试医生', note: '已核对', constants: [{ idx: 0, source: '《某某出行用药指南》第3章（测试医生已核对）' }] });
    ok('保存修改：仍是待审核', r.s === 200 && r.d.status === 'pending_review', JSON.stringify(r.d.changes));
    ok('修改后“需人工确认”清空', (r.d.lint.human || []).length === 0);
    let list = (await j('GET', '/api/widgets/admin/tools?status=pending_review')).d.tools;
    let t1 = list.find((t) => t.id === d1.d.toolId);
    ok('审核页能看到新出处与修改记录', t1 && t1.spec.constants[0].source.includes('第3章') && t1.review.history.some((h) => h.action === 'edit'));

    // 4 修改并通过
    r = await j('POST', `/api/widgets/admin/tools/${d1.d.toolId}/edit`, { reviewer: '测试医生', note: '改免责声明后通过', disclaimer: '仅为出行准备参考；具体用药请遵医嘱。', approve: true });
    ok('修改并通过：已上架', r.s === 200 && r.d.status === 'approved');
    const ap = (await j('GET', '/api/widgets/admin/tools?status=approved')).d.tools.find((t) => t.id === d1.d.toolId);
    ok('已上架且记录为医生审核通过', ap && ap.approved_mode === 'doctor' && ap.approved_by === '测试医生' && ap.review.history.map((h) => h.action).join() === 'edit,edit,approve', ap && ap.review.history.map((h) => h.action).join());
    r = await j('POST', `/api/widgets/admin/tools/${d1.d.toolId}/edit`, { reviewer: 'x', disclaimer: '再改' });
    ok('已上架的工具不能再改(409)', r.s === 409);

    // 5 打回重做：必须填意见（用测试客户 + 真实的“出差带药”需求，这样 AI 不会把它当成无意义需求丢掉）
    const cl = await fetch(BASE + '/api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `test_sandbox_regen_${sfx}` }) }).then((x) => x.json());
    clients.push(cl.id);
    const rq = await fetch(`${BASE}/api/clients/${cl.id}/widgets/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ name: '出差带药准备', why: '用户说下周坐飞机出差7天，药怎么分装带、要带几天的量' }], disease_label: '鼻腔肿物切除术后', catalog: ['服药提醒', '定制饮食'] }) }).then((x) => x.json());
    const k2 = `test_sandbox_regen_${sfx}`;
    const d2 = await j('POST', '/api/widgets/admin/drafts', { spec: spec(k2, `test_sandbox 打回重做 ${sfx}`, [{ value: '备用多留 5 天', source: 'pending_review' }]), why: '用户说下周出差，药怎么带', disease_label: '鼻腔肿物切除术后', request_id: rq.requests[0].id, judge_override: PASS });
    created.push(d2.d.toolId);
    r = await j('POST', `/api/widgets/admin/tools/${d2.d.toolId}/reject`, { reviewer: '测试医生', regenerate: true });
    ok('打回重做不填意见被拒(400)', r.s === 400, r.d.error);
    ok('被拒后工具仍待审核', (await j('GET', '/api/widgets/admin/tools?status=pending_review')).d.tools.some((t) => t.id === d2.d.toolId));

    // 6 打回重做：原工具被驳回，生成新需求，跟踪到 AI 生成完成
    r = await j('POST', `/api/widgets/admin/tools/${d2.d.toolId}/reject`, { reviewer: '测试医生', note: '备用天数不要写死5天，改成让用户自己填', regenerate: true });
    const nrid = r.d.regenerate && r.d.regenerate.requestId;
    ok('打回重做成功，并排队了新的生成', r.s === 200 && r.d.status === 'rejected' && !!nrid, JSON.stringify(r.d));
    const rej = (await j('GET', '/api/widgets/admin/tools?status=rejected')).d.tools.find((t) => t.id === d2.d.toolId);
    ok('原工具记录为“打回重做”', rej && rej.review.history.some((h) => h.action === 'reject' && h.regenerate && h.note.includes('不要写死')));
    r = await j('POST', `/api/widgets/admin/tools/${d2.d.toolId}/reject`, { reviewer: 'x', note: 'y', regenerate: true });
    ok('重复打回被拒(409)', r.s === 409);
    console.log('（等待 AI 按意见重新生成，最多 120 秒…）');
    let rs = null;
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      rs = (await j('GET', `/api/widgets/admin/requests/${nrid}`)).d;
      if (rs && !['queued', 'generating'].includes(rs.status)) break;
    }
    ok('新需求的 why 里带着医生意见', rs && String(rs.why).includes('医生打回意见') && String(rs.why).includes('不要写死'));
    ok('AI 已按意见重新生成并走完流水线', rs && ['in_review', 'ready'].includes(rs.status) && !!rs.tool_id, rs ? `${rs.status} / tool=${rs.tool_id} / ${rs.note}` : 'no status');
    if (rs && rs.tool_id) created.push(rs.tool_id);
  } catch (e) {
    ok('测试流程异常', false, String(e.message || e));
  } finally {
    try {
      if (created.length) { const c = await j('POST', '/api/widgets/admin/_test_cleanup', { ids: created.filter(Boolean) }); console.log('清理工具', JSON.stringify(c.d)); }
      for (const id of clients) await fetch(`${BASE}/api/clients/${id}`, { method: 'DELETE' }).catch(() => {});
      if (origMode) await j('PUT', '/api/widgets/admin/settings', { review_mode: origMode });
      const s2 = await j('GET', '/api/widgets/admin/settings');
      ok('审核模式已恢复', s2.d.review_mode === origMode, s2.d.review_mode);
    } catch (e) { console.log('收尾失败', e.message); }
    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(fail ? 1 : 0);
  }
})();
