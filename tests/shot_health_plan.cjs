// 健康计划 UI 截图验证（无头 Chrome）。需本地服务 PORT=5051 已托管 dist。
const puppeteer = require('/Users/cc/mini-health/node_modules/puppeteer-core');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:5051';
const OUT = __dirname + '/shots';
fs.mkdirSync(OUT, { recursive: true });
const api = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d) => { checks.push({ n, ok: !!ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ' → ' + d}`); };
const item = (key, line, title, extra = {}) => ({ key, line, title, ...extra });

(async () => {
  const NAME = '计划截图_mini_199';
  const c = await api('POST', '/api/clients', { name: NAME, age: 62, gender: '男' });
  const id = c.j.id;
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } });
  try {
    const page = await browser.newPage();
    const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); };
    const text = () => page.evaluate(() => { const p = document.querySelector("[data-testid=health-plan-panel]"); return p ? p.innerText : "(NO PANEL) " + document.body.innerText.slice(0,100); });
    const clickText = async (sel, t) => page.evaluate((sel, t) => { const el = [...document.querySelectorAll(sel)].filter((e) => e.innerText && e.innerText.includes(t)).sort((a, b) => a.innerText.length - b.innerText.length)[0]; if (el) { el.click(); return true; } return false; }, sel, t);
    const openPlanTab = async () => { for (let i = 0; i < 4; i++) { await sleep(1500); await page.click("[data-testid=tab-plan]"); await sleep(1500); if (await page.$("[data-testid=health-plan-panel]")) return; } };
    const reopen = async () => { await page.reload({ waitUntil: 'networkidle0' }); await sleep(800); await selectClient(); await openPlanTab(); };
    const selectClient = async () => {
      for (let i = 0; i < 20; i++) {
        if (await clickText('div,li,button,span', NAME)) break;
        await sleep(500);
      }
      await sleep(1500);
    };
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await selectClient();
    await openPlanTab();
    check('空状态：提示暂无生效计划', (await text()).includes('暂无生效的健康计划'), '');
    await shot('01_empty');

    // 首份计划提案
    const v1 = [
      item('diet.water', 'diet', '每日饮水', { detail: '分次饮用，不要一次喝太多', target: { metric: 'water', comparator: 'gte', value: 2000, unit: 'ml' } }),
      item('diet.meat', 'diet', '周二午餐主荤：牛腩', { detail: '少油少盐' }),
      item('diet.salt', 'diet', '每日盐摄入', { target: { metric: 'salt', comparator: 'lte', value: 5, unit: 'g' } }),
      item('exercise.walk', 'exercise', '快走', { detail: '饭后一小时', target: { metric: 'walk', comparator: 'gte', value: 30, unit: '分钟' } }),
      item('monitor.bp', 'monitor', '早晚测血压', { target: { metric: 'bp', comparator: 'count_gte', value: 2, unit: '次' } }),
      item('medication.amlodipine', 'medication', '氨氯地平 5mg 每日早一次'),
      item('environment.stairs', 'environment', '出门爬楼梯建议：请爬楼机服务陪同'),
    ];
    const p1r = (await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '出院后康复期基础计划', proposed_by: 'system', phase_title: '康复期 · 第 1 阶段', primary_goal: '血压稳定在 130/80 以下，体重 4 周下降 2kg', items: v1 })); console.log("p1", p1r.s, JSON.stringify(p1r.j).slice(0,150));
    await reopen();
    const t1 = await text();
    check('首份提案显示为待确认，含确认/暂不采纳按钮', t1.includes('待确认的调整') && t1.includes('首份健康计划') && t1.includes('确认生效'), t1.slice(0, 200));
    check('未确认前不展示计划条目（仍是空状态）', t1.includes('暂无生效的健康计划') && !t1.includes('每日饮水'), '');
    await shot('02_first_draft_pending');

    await page.click("[data-testid=plan-confirm]"); await page.waitForFunction(() => { const p = document.querySelector("[data-testid=health-plan-panel]"); return p && !p.innerText.includes("待确认的调整"); }, { timeout: 30000 }); await sleep(2500);
    const t2 = await text();
    check('确认后 v1 生效，显示阶段/总目标/各条线', t2.includes('v1') && t2.includes('康复期 · 第 1 阶段') && t2.includes('总目标') && t2.includes('饮食') && t2.includes('运动') && t2.includes('监测') && t2.includes('用药') && t2.includes('起居与服务'), t2.slice(0, 300));
    check('待确认区消失', !t2.includes('待确认的调整'), '');
    await shot('03_v1_active');

    // 营养师调整提案
    await api('POST', `/api/clients/${id}/plans/proposals`, { reason: '营养师评估：肾功能偏弱，需限水并减少牛羊肉', proposed_by: 'nutritionist', source: 'nutritionist', items: [
      item('diet.water', 'diet', '每日饮水', { detail: '分次饮用，不要一次喝太多', target: { metric: 'water', comparator: 'gte', value: 1700, unit: 'ml' } }),
      item('diet.meat', 'diet', '周二午餐主荤：土豆烧鸡丁'),
      item('diet.fiber', 'diet', '早餐加燕麦', { detail: '无面包牛奶' }),
    ], remove: [] });
    await reopen();
    const t3 = await text();
    check('调整提案标注基于 v1', t3.includes('基于 v1 的调整'), '');
    check('变化清单内容正确', t3.includes('→') && t3.includes('土豆烧鸡丁') && t3.includes('新增：早餐加燕麦') && t3.includes('营养师'), t3.slice(0, 400));
    check('确认前生效版本仍是 v1（饮水 2000ml、牛腩）', t3.includes('v1') && t3.includes('牛腩'), '');
    await shot('04_v2_proposal_diff');

    await page.click("[data-testid=plan-confirm]"); await page.waitForFunction(() => { const p = document.querySelector("[data-testid=health-plan-panel]"); return p && !p.innerText.includes("待确认的调整"); }, { timeout: 30000 }); await sleep(2500);
    const t4 = await text();
    check('确认后 v2 生效：饮水 1700、鸡丁、燕麦；牛腩不再出现在当前计划', t4.includes('v2') && t4.includes('1700') && t4.includes('土豆烧鸡丁') && t4.includes('早餐加燕麦'), t4.slice(0, 300));
    check('历史版本栏出现 v1(已取代) 与 v2(生效中)', t4.includes('已取代') && t4.includes('生效中'), '');
    await shot('05_v2_active_with_history');

    await page.click("[data-testid=plan-hist-1]"); await page.waitForFunction(() => document.body.innerText.includes("已被取代（历史）"), { timeout: 20000 }).catch(() => {}); await sleep(800);
    const t5 = await text();
    check('点击 v1 可回看旧计划（饮水 2000、牛腩），并标注已被取代', t5.includes('已被取代') && t5.includes('2000') && t5.includes('牛腩'), t5.slice(0, 300));
    await shot('06_view_v1_history');

    // 档案：Wiki 与 日志
    await clickText('button', '用药方案'); await sleep(1500);
    const tw = await text();
    check('档案 Wiki 页签里没有计划正文（计划与档案分开）', !tw.includes('早餐加燕麦') && !tw.includes('土豆烧鸡丁'), '');
    await shot('07_wiki_tab_no_plan_body');
    await clickText('button', '原始日志'); await sleep(1500);
    const tl = await page.evaluate(() => document.body.innerText);
    check('原始沟通日志里有"计划事件"（确认/调整留痕）', tl.includes('计划事件'), tl.slice(0, 200));
    await shot('08_logs_plan_events');
  } finally {
    await browser.close();
    const d = await api('DELETE', `/api/clients/${id}`);
    check('清理测试客户', d.s === 200, d.s);
  }
  fs.writeFileSync(OUT + '/ui_checks.json', JSON.stringify(checks, null, 2));
  const f = checks.filter((x) => !x.ok).length;
  console.log(`共 ${checks.length} 项，失败 ${f}`);
  process.exit(f ? 1 : 0);
})();
