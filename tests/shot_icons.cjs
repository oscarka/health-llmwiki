// 截图：右侧按钮改为仅图标后的布局（用 id 找客户；默认第一个客户）
const puppeteer = require('/Users/cc/mini-health/node_modules/puppeteer-core');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:5051';
const OUT = process.env.OUT || (__dirname + '/shots_icons');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } });
  try {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await sleep(1500);
    // 选第一个客户
    await page.evaluate(() => { const el = [...document.querySelectorAll('div,li')].filter((e) => e.innerText && e.innerText.includes('测试王')).sort((a, b) => a.innerText.length - b.innerText.length)[0]; if (el) el.click(); });
    await sleep(2500);
    await page.screenshot({ path: OUT + '/01_icons_only.png' });
    // 悬停提示：读取 title
    const titles = await page.evaluate(() => [...document.querySelectorAll('.sheet-nav-actions button')].map((b) => ({ title: b.getAttribute('title'), text: b.innerText.trim() })));
    console.log(JSON.stringify(titles));
    fs.writeFileSync(OUT + '/buttons.json', JSON.stringify(titles, null, 2));
    // 计划页签
    await page.click('[data-testid="tab-plan"]'); await sleep(1500);
    await page.screenshot({ path: OUT + '/02_plan_tab_buttons.png' });
    const rect = await page.evaluate(() => { const bar = document.querySelector('.sheet-nav-bar'); const acts = document.querySelector('.sheet-nav-actions'); return { barW: bar.clientWidth, barScroll: bar.scrollWidth, actsRight: acts.getBoundingClientRect().right, barRight: bar.getBoundingClientRect().right }; });
    console.log(JSON.stringify(rect));
    fs.writeFileSync(OUT + '/layout.json', JSON.stringify(rect, null, 2));
  } finally { await browser.close(); }
})();
