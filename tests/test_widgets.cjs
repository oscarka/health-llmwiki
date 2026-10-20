/**
 * 小工具流水线测试：医生审核模式 + 完全自动模式。
 * 用法：TEST_BASE_URL=... WIDGET_REVIEW_TOKEN=... node tests/test_widgets.cjs [--real-ai]
 * 只用 test_sandbox_* 客户；工具名/scenario_key 带 test_sandbox 前缀；结束后清理。
 * 结果写入 tests/out/widgets_result.json 供报告使用。
 */
const fs = require('fs');
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5071';
const TOKEN = process.env.WIDGET_REVIEW_TOKEN || '';
const REAL_AI = process.argv.includes('--real-ai');
const H = { 'Content-Type': 'application/json', 'x-review-token': TOKEN };
const j = async (m, p, b, h = H) => { const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); let d = {}; try { d = await r.json(); } catch (e) { /* */ } return { s: r.status, d }; };
const results = []; let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { results.push({ name, ok: !!cond, extra }); cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); };
const sfx = Date.now().toString(36);

const goodSpec = (key, name) => ({
  id: key, name, kind: '计算器', scenario_key: key,
  trigger: { when: '用户自述近期要坐飞机/高铁出差，需要决定药怎么分装带' },
  inputs: [{ key: 'days', label: '要出门几天', type: 'number', default: 3 }, { key: 'delay', label: '万一返程延误，最多预留几天', type: 'number', default: 2 }, { key: 'check', label: '是否有托运行李', type: 'select', options: ['有托运', '只有随身包'], default: '有托运' }],
  program: '随身包放全部路上要吃的药（出门天数+延误预留天数）；有托运行李时，另放一份备份到托运行李，按出门天数计',
  program_code: 'function main(inputs){var d=Number(inputs["days"])||0;var b=Number(inputs["delay"])||0;var c=inputs["check"]==="有托运";var r={"随身包必须带的天数":(d+b)+"天的量","托运行李里的备份":c?d+"天的量（只做备份）":"不需要，药全部放随身包"};r["最重要的一条"]="每天要吃的药一律放随身包，不要只放托运";return r;}',
  output: '随身包与托运行李里各放几天的药', content: [{ title: '出发前要做的三件事', items: ['药盒分装后，同时保留药品原包装或带药名的说明书', '随身带上近期的出院小结/处方复印件，过安检被问时可出示', '记下目的地附近能拿药的医院，并确认药在当地的购买途径'] }],
  disclaimer: '仅为出行准备参考，具体用药请遵医嘱', constants: [], sources: ['无固定医学常数，属于行李安排'], not_do: ['不改药量', '不提醒吃药时间'],
});
const specB = (key, name) => ({
  id: key, name, kind: '清单', scenario_key: key, trigger: { when: '用户要去上一次复诊，不知道该带哪些材料' },
  inputs: [], program: '把复诊当天要带的材料按“必带/最好带”列成清单', output: '复诊材料清单',
  content: [{ title: '必带', items: ['身份证和医保卡', '出院小结或上次门诊病历', '正在吃的药的包装盒或药单'] }, { title: '最好带', items: ['近期的血压记录截图', '想问医生的问题写在手机备忘录里', '上次检查的报告和光盘'] }],
  disclaimer: '', constants: [], sources: ['无固定医学常数，属于就医流程准备'], not_do: ['不改药', '不做症状判断'],
});
const specC = (key, name) => ({
  id: key, name, kind: '分步图文', scenario_key: key, trigger: { when: '用户自述要到外地出差，当地用医保看病不知道怎么办' },
  inputs: [], program: '把异地就医备案的办理步骤按顺序列出来', output: '异地就医备案办理步骤',
  content: [{ title: '出发前的备案步骤', items: ['打开本地医保公众号或 App，找到“异地就医备案”入口', '按提示填写出差地址和预计停留时间，上传身份证明', '提交后截图保存备案成功页面，就医时可出示', '到当地医院用医保电子凭证挂号，先问客服是否支持直接结算'] }],
  disclaimer: '', constants: [], sources: ['无固定医学常数，属于办事流程，具体以当地医保为准'], not_do: ['不做报销金额计算'],
});
const humanSpec = (key, name) => ({ ...specB(key, name), constants: [{ value: '复诊前建议空腹检查项目需空腹至少8小时', source: 'pending_review' }] });
const CB = { situation: '冠心病支架术后第10天，下周三要去医院第一次复诊；用户自述：不知道复诊要带哪些材料', disease_label: '冠心病支架术后', catalog: ['服药提醒', '定制饮食', '血压记录'], name: '复诊材料准备', why: '用户说下周三第一次复诊，不知道带什么材料' };
const CC = { situation: '冠心病支架术后，下周要去外地出差一周；用户自述：外地用医保看病不知道怎么办', disease_label: '冠心病支架术后', catalog: ['服药提醒', '定制饮食', '血压记录'], name: '外地出差医保怎么用', why: '用户说要外地出差一周，担心当地看病医保怎么用' };
const PASS = { verdict: 'pass', scope: '办事', reasons: '流程判定逻辑测试' };
const CTX = { situation: '冠心病支架术后第10天，下周需要坐飞机出差3天；用户自述：药怎么带、放哪里不清楚', disease_label: '冠心病支架术后', catalog: ['服药提醒', '定制饮食', '血压记录'], name: '出差带药准备' };
const dietSpec = (key, name) => ({ ...goodSpec(key, name), kind: '清单', program_code: '', scenario_key: key, output: '饮食清单', trigger: { when: '想知道每天吃什么' }, content: [{ title: '今日吃什么', items: ['早餐吃燕麦', '午餐吃杂粮饭', '晚餐吃清蒸鱼'] }], program: '推荐每天吃什么食物' });
const unsafeSpec = (key, name) => ({ ...goodSpec(key, name), program_code: 'function main(inputs){return {"结果":process.env.HOME};}' });
const enSpec = (key, name) => ({ ...goodSpec(key, name), inputs: [{ key: 'days', label: 'days', type: 'number', default: 5 }] });

(async () => {
  const created = []; const clients = [];
  let origSettings = null;
  try {
    // 0 鉴权
    ok('无口令访问管理接口被拒(403)', (await j('GET', '/api/widgets/admin/settings', null, { 'Content-Type': 'application/json' })).s === 403);
    ok('错误口令被拒(403)', (await j('GET', '/api/widgets/admin/settings', null, { 'x-review-token': 'wrong' })).s === 403);
    const st = await j('GET', '/api/widgets/admin/settings');
    ok('正确口令能读开关', st.s === 200 && ['manual', 'auto'].includes(st.d.review_mode), JSON.stringify(st.d));
    origSettings = st.d;

    // 建测试客户
    const mk = async (name) => { const r = await j('POST', '/api/clients', { name }, { 'Content-Type': 'application/json' }); clients.push(r.d.id); return r.d.id; };
    const c1 = await mk('test_sandbox_widget_a'); const c2 = await mk('test_sandbox_widget_b');

    // 1 需求登记
    const rq = await j('POST', `/api/clients/${c1}/widgets/requests`, { items: [{ name: '出差带药计算', why: '用户说下周要出差' }, { name: '', why: 'x' }], disease_label: '测试病种', catalog: ['服药提醒'] }, { 'Content-Type': 'application/json' });
    ok('登记需求 201', rq.s === 201 && rq.d.requests && rq.d.requests.length === 1);
    const rq2 = await j('POST', `/api/clients/${c1}/widgets/requests`, { items: [{ name: '出差带药计算', why: 'again' }] }, { 'Content-Type': 'application/json' });
    ok('同一用户同名需求去重', rq2.d.requests[0].existed === true);
    ok('空 items 返回 400', (await j('POST', `/api/clients/${c1}/widgets/requests`, { items: [] }, { 'Content-Type': 'application/json' })).s === 400);
    ok('不存在客户返回 404', (await j('POST', `/api/clients/nope_${sfx}/widgets/requests`, { items: [{ name: 'a' }] }, { 'Content-Type': 'application/json' })).s === 404);
    const rid1 = rq.d.requests[0].id;

    // 2 ===== 医生审核模式 =====
    await j('PUT', '/api/widgets/admin/settings', { review_mode: 'manual', gen_enabled: 'on' });
    ok('开关切到「医生审核」', (await j('GET', '/api/widgets/admin/settings')).d.review_mode === 'manual');
    const k1 = `test_sandbox_trip_${sfx}`;
    const d1 = await j('POST', '/api/widgets/admin/drafts', { spec: goodSpec(k1, `test_sandbox 出差带药 ${sfx}`), why: '用户说下周坐飞机出差，药不知道怎么带', ...CTX, request_id: rid1, judge_override: PASS });
    created.push(d1.d.toolId);
    ok('【医生模式】干净草稿 → 待医生审核(不会自动上架)', d1.s === 201 && d1.d.toolStatus === 'pending_review', `${d1.d.toolStatus} / ${d1.d.reason} / ${JSON.stringify(d1.d.judge && d1.d.judge.reasons)}`);
    let w = await j('GET', `/api/clients/${c1}/widgets`, null, { 'Content-Type': 'application/json' });
    ok('【医生模式】用户端此时看到“准备中”，没有工具内容', w.d.widgets.length === 1 && w.d.widgets[0].status === 'preparing' && !w.d.widgets[0].tool);
    ok('【医生模式】未上架的工具用户不能运行(404)', (await j('POST', `/api/widgets/tools/${d1.d.toolId}/run`, { inputs: {} }, { 'Content-Type': 'application/json' })).s === 404);
    const pend = await j('GET', '/api/widgets/admin/tools?status=pending_review');
    ok('审核台待审列表里能看到它，且带示例运行结果', pend.d.tools.some((t) => t.id === d1.d.toolId && t.sample_result && t.sample_result['随身包必须带的天数']), '');
    const ap = await j('POST', `/api/widgets/admin/tools/${d1.d.toolId}/approve`, { reviewer: '测试医生', note: '核对无误' });
    ok('医生点通过 → approved', ap.s === 200 && ap.d.status === 'approved');
    ok('重复审核被拒(409)', (await j('POST', `/api/widgets/admin/tools/${d1.d.toolId}/approve`, {})).s === 409);
    w = await j('GET', `/api/clients/${c1}/widgets`, null, { 'Content-Type': 'application/json' });
    ok('【医生模式】通过后用户端看到可用工具', w.d.widgets[0].status === 'ready' && w.d.widgets[0].tool && w.d.widgets[0].tool.inputs.length === 3);
    ok('用户端数据里不含程序代码', !JSON.stringify(w.d).includes('program_code') && !JSON.stringify(w.d).includes('function main'));
    const run = await j('POST', `/api/widgets/tools/${d1.d.toolId}/run`, { inputs: { days: 7, delay: 3, check: '有托运' } }, { 'Content-Type': 'application/json' });
    ok('用户运行工具得到中文结果(7+3=10天)', run.s === 200 && run.d.result && run.d.result['随身包必须带的天数'] === '10天的量', JSON.stringify(run.d.result));
    const done = await j('GET', '/api/widgets/admin/tools?status=approved');
    const me = done.d.tools.find((t) => t.id === d1.d.toolId);
    ok('记录了谁通过的：医生/测试医生', me && me.approved_mode === 'doctor' && me.approved_by === '测试医生');

    // 医生驳回
    const k2 = `test_sandbox_trip2_${sfx}`;
    const d2 = await j('POST', '/api/widgets/admin/drafts', { spec: specB(k2, `test_sandbox 复诊材料清单 ${sfx}`), why: '用户说下周坐飞机出差，药不知道怎么带', ...CB, judge_override: PASS });
    created.push(d2.d.toolId);
    const rj = await j('POST', `/api/widgets/admin/tools/${d2.d.toolId}/reject`, { reviewer: '测试医生', note: '不需要' });
    ok('医生驳回 → rejected，用户不可用', rj.d.status === 'rejected' && (await j('POST', `/api/widgets/tools/${d2.d.toolId}/run`, { inputs: {} }, { 'Content-Type': 'application/json' })).s === 404);

    // 3 ===== 完全自动模式 =====
    await j('PUT', '/api/widgets/admin/settings', { review_mode: 'auto' });
    ok('开关切到「完全自动」', (await j('GET', '/api/widgets/admin/settings')).d.review_mode === 'auto');
    const rq3 = await j('POST', `/api/clients/${c2}/widgets/requests`, { items: [{ name: '自动模式出差带药', why: '用户要出差' }], disease_label: '测试病种' }, { 'Content-Type': 'application/json' });
    const k3 = `test_sandbox_auto_${sfx}`;
    const d3 = await j('POST', '/api/widgets/admin/drafts', { spec: specC(k3, `test_sandbox 异地医保备案 ${sfx}`), why: '用户说下周坐飞机出差，药不知道怎么带', ...CC, request_id: rq3.d.requests[0].id, judge_override: PASS });
    created.push(d3.d.toolId);
    ok('【自动模式】干净草稿 → 不经医生直接上架', d3.d.toolStatus === 'approved', `${d3.d.toolStatus} / ${d3.d.reason}`);
    w = await j('GET', `/api/clients/${c2}/widgets`, null, { 'Content-Type': 'application/json' });
    ok('【自动模式】用户端立即看到可用工具', w.d.widgets[0] && w.d.widgets[0].status === 'ready');
    const ap3 = (await j('GET', '/api/widgets/admin/tools?status=approved')).d.tools.find((t) => t.id === d3.d.toolId);
    ok('记录为「AI自动」上架', ap3 && ap3.approved_mode === 'auto' && ap3.approved_by === 'AI自动');
    const d4 = await j('POST', '/api/widgets/admin/drafts', { spec: humanSpec(`test_sandbox_human_${sfx}`, `test_sandbox 复诊材料清单B ${sfx}`), why: '用户说下周坐飞机出差，药不知道怎么带', ...CB, name: '复诊材料准备B', judge_override: PASS });
    created.push(d4.d.toolId);
    ok('【自动模式】含“待人工确认出处”的常数 → 仍转医生，不自动上架', d4.d.toolStatus === 'pending_review', d4.d.reason);
    const d5 = await j('POST', '/api/widgets/admin/drafts', { spec: dietSpec(`test_sandbox_diet_${sfx}`, `test_sandbox 今日吃什么 ${sfx}`), why: '想知道吃什么', disease_label: '测试病种' });
    created.push(d5.d.toolId);
    ok('【自动模式】饮食类被拦截(auto_rejected)', d5.d.toolStatus === 'auto_rejected', d5.d.reason);
    const d6 = await j('POST', '/api/widgets/admin/drafts', { spec: unsafeSpec(`test_sandbox_unsafe_${sfx}`, `test_sandbox 不安全代码 ${sfx}`), why: 'x' });
    created.push(d6.d.toolId);
    ok('【自动模式】含危险代码被拦截', d6.d.toolStatus === 'auto_rejected');
    const d7 = await j('POST', '/api/widgets/admin/drafts', { spec: enSpec(`test_sandbox_en_${sfx}`, `test_sandbox 英文标签 ${sfx}`), why: 'x' });
    created.push(d7.d.toolId);
    ok('【自动模式】英文输入框标签被拦截', d7.d.toolStatus === 'auto_rejected');
    const d8 = await j('POST', '/api/widgets/admin/drafts', { spec: specC(k3, 'dup'), why: '重复', ...CC });
    ok('同场景再次生成 → 复用已有工具，不重复造', d8.d.reused === true && d8.d.toolId === d3.d.toolId);
    const rejList = (await j('GET', '/api/widgets/admin/tools?status=auto_rejected')).d.tools;
    ok('自动拦截的不会出现在用户端，审核台可复查原因', rejList.some((t) => t.id === d5.d.toolId));

    // 4 总开关：关闭自动生成
    await j('PUT', '/api/widgets/admin/settings', { gen_enabled: 'off' });
    const rq4 = await j('POST', `/api/clients/${c2}/widgets/requests`, { items: [{ name: '关闭生成时的需求', why: 'x' }] }, { 'Content-Type': 'application/json' });
    const g = await j('POST', `/api/clients/${c2}/widgets/requests/${rq4.d.requests[0].id}/generate`, {}, { 'Content-Type': 'application/json' });
    ok('生成开关=关：需求只排队不生成', g.d.result && g.d.result.skipped === 'gen_disabled');
    w = await j('GET', `/api/clients/${c2}/widgets`, null, { 'Content-Type': 'application/json' });
    ok('生成关闭时用户端显示“准备中”', w.d.widgets.some((x) => x.name === '关闭生成时的需求' && x.status === 'preparing'));
    ok('非法开关值 400', (await j('PUT', '/api/widgets/admin/settings', { review_mode: 'xx' })).s === 400);
    await j('PUT', '/api/widgets/admin/settings', { gen_enabled: 'on' });

    // 5 真实 AI 生成（可选）
    if (REAL_AI) {
      for (const mode of ['manual', 'auto']) {
        await j('PUT', '/api/widgets/admin/settings', { review_mode: mode });
        const c = await mk(`test_sandbox_widget_ai_${mode}`);
        const r = await j('POST', `/api/clients/${c}/widgets/requests`, { items: [{ name: '出院后坐飞机出差带药准备', why: '用户说出院第10天要坐飞机出差3天，不知道药怎么带' }], disease_label: '冠心病支架术后', source: 'test_sandbox', catalog: ['服药提醒', '定制饮食', '血压记录'] }, { 'Content-Type': 'application/json' });
        const t0 = Date.now();
        const gen = await j('POST', `/api/clients/${c}/widgets/requests/${r.d.requests[0].id}/generate`, {}, { 'Content-Type': 'application/json' });
        const res = gen.d.result || {};
        if (res.toolId) created.push(res.toolId);
        const secs = Math.round((Date.now() - t0) / 1000);
        const expect = mode === 'auto' ? ['ready', 'in_review', 'dropped'] : (res.reused ? ['ready'] : ['in_review', 'dropped']);
        ok(`【真实AI·${mode === 'auto' ? '自动' : '医生'}模式】AI 自己起草并走完流水线(${secs}s)`, expect.includes(res.status) && res.status !== 'failed', `状态=${res.status} ${res.reason || res.note || res.error || ''}`);
        if (mode === 'manual') ok('【真实AI·医生模式】AI 出的新工具不会直接上架', !(res.status === 'ready' && !res.reused), res.reused ? '复用了已上架的工具(早已审核过)' : '');
      }
    }
  } catch (e) {
    ok('测试运行无异常', false, e.message);
  } finally {
    // 清理
    try {
      if (origSettings) await j('PUT', '/api/widgets/admin/settings', { review_mode: origSettings.review_mode, gen_enabled: origSettings.gen_enabled });
      const pgTools = created.filter(Boolean);
      if (pgTools.length) await j('POST', '/api/widgets/admin/_test_cleanup', { ids: pgTools });
      for (const id of clients) await j('DELETE', `/api/clients/${id}`, null, { 'Content-Type': 'application/json' });
    } catch (e) { console.log('cleanup err', e.message); }
    fs.mkdirSync('tests/out', { recursive: true });
    fs.writeFileSync('tests/out/widgets_result.json', JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, fail, results }, null, 1));
    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(fail ? 1 : 0);
  }
})();
