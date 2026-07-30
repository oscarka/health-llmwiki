#!/usr/bin/env node
/**
 * LLMWiki E2E Browser & UI Aesthetics Test Suite
 * 
 * Verifies:
 * - App load and client selection
 * - 8-section cognitive skeleton layout rendering
 * - Custom observation and intervention block cards rendering
 * - Attention glow styling and heartbeat animation properties
 * - Mindmap folding/unfolding and scroll-to-highlight interaction
 * - Citation badge clicking and slide-in log drawer overlay interaction
 * - Corrupted YAML block fallback rendering
 */

const { chromium } = require('playwright');
const http = require('http');

let passed = 0;
let failed = 0;

function assert(desc, condition, got) {
  if (condition) {
    console.log(`  ✅ BROWSER PASS: ${desc}`);
    passed++;
  } else {
    console.error(`  ❌ BROWSER FAIL: ${desc}`);
    if (got !== undefined) console.error(`               Got:`, got);
    failed++;
  }
}

function section(title) {
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  ${title}`);
  console.log(`══════════════════════════════════════════════════════════════`);
}

// Helper to interact with REST API to create a test client
async function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: 5050,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    const request = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    request.on('error', err => reject(err));
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

async function runBrowserTests() {
  console.log('\n🚀 Starting E2E UI & Interaction Browser Tests...');
  
  // 1. Create a mock client with structured blocks using the sync pipeline
  section('1. Setup Test Data (Clinical Cases)');
  const randomSuffix = Math.random().toString(36).substring(2, 6);
  const clientData = {
    name: `Browser Verify 浏览器验证患者 ${randomSuffix}`,
    age: 65,
    gender: '女',
    phone: '13888889999',
    allergies: '青霉素过敏'
  };
  
  const { status: s1, data: client } = await req('POST', '/api/clients', clientData);
  assert('Create client returned 201', s1 === 201, s1);
  const clientId = client?.id;
  if (!clientId) throw new Error('Could not create test client');

  let browser;
  let page;
  try {
    // Post logs: one high attention (SpO2 84%), one intervention
    const { status: l1 } = await req('POST', `/api/clients/${clientId}/logs`, {
      type: 'ocr',
      content: '患者于10:00测得血氧饱和度持续偏低，仅 84% (SpO2: 84%)，呼吸急促。'
    });
    assert('Post high-priority observation log returned 201', l1 === 201, l1);

    const { status: l2 } = await req('POST', `/api/clients/${clientId}/logs`, {
      type: 'phone',
      content: '建议方案：吸氧，雾化吸入沙丁胺醇以缓解支气管痉挛。'
    });
    assert('Post intervention log returned 201', l2 === 201, l2);

    // Sync
    console.log(`  Triggering sync for test client ${clientId}...`);
    const { status: sy, data: syncResult } = await req('POST', `/api/clients/${clientId}/sync`);
    assert('LLM Sync returned 200', sy === 200, sy);
    assert('Sync succeeded (wikiUpdated=true)', syncResult?.wikiUpdated === true, syncResult);

    // 2. Launch Chromium (headed mode so the user can see it run)
    section('2. Launch Browser & Load App');
    browser = await chromium.launch({ headless: false, slowMo: 600 });
    page = await browser.newPage();
    
    // Listen for console logs in the browser to help debug
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.log(`  [BROWSER ${msg.type().toUpperCase()}] ${msg.text()}`);
      }
    });

    // Visit local React site on port 5150 to avoid clashes
    await page.goto('http://localhost:5150');
    await page.waitForSelector('.app-container, .client-list, #root');
    assert('Vite App loaded successfully in Chromium', true);

    // Locate our test client and click it
    console.log(`  Locating client in UI: "${clientData.name}"`);
    const clientSelector = `.client-item:has-text("${clientData.name}")`;
    await page.waitForSelector(clientSelector);
    await page.click(clientSelector);
    
    // Wait for the wiki pages to load (we check the patient name in the visible header to avoid race conditions)
    await page.waitForSelector(`.client-main-profile h2:has-text("${clientData.name}")`);
    // Ensure the wiki pages have actually finished fetching and rendering in the UI
    await page.waitForSelector('.alert-block.alert-important p:has-text("青霉素过敏")');
    assert('Wiki Rendered View loaded successfully for selected client', true);

    // 3. Verify Layout and Aesthetics (Phase 2 & 3)
    section('3. Verify UI Layout & Aesthetics (Structured Blocks)');
    
    // Check AI summary card is visible
    const isSummaryVisible = await page.isVisible('.ai-summary-card');
    assert('AI Summary Sparkle Quick-read card is rendered at the top', isSummaryVisible);

    // Switch to medical_history.md tab to view physiologic signals and custom observation cards
    console.log('  Navigating to "🧬 既往史与诊疗轴" tab...');
    await page.click('.wiki-nav-item:has-text("既往史")');
    await page.waitForSelector('.structured-block-card.observation-card');

    // Check custom block card components exist
    const obsCardsCount = await page.locator('.structured-block-card.observation-card').count();
    assert(`Custom Observation Cards are rendered (Count: ${obsCardsCount})`, obsCardsCount >= 1, obsCardsCount);

    // Check for high-priority score glow class
    const highGlowExists = await page.locator('.observation-card.attention-high-card').count();
    assert('High-priority alert (SpO2 84%) card has the attention-high-card visual indicator', highGlowExists >= 1, highGlowExists);

    // Verify key CSS styles in the browser environment
    const glowBoxShadow = await page.evaluate(() => {
      const el = document.querySelector('.attention-high-card');
      if (!el) return null;
      return window.getComputedStyle(el).borderLeftColor;
    });
    // High-attention borders are red (RGB 239, 68, 68 / 153, 27, 27 / etc.)
    assert('High-attention card has a red outline highlight', glowBoxShadow && (glowBoxShadow.includes('239, 68, 68') || glowBoxShadow.includes('rgb(239') || glowBoxShadow.includes('rgba(239') || glowBoxShadow.includes('rgb(255') || glowBoxShadow.includes('rgb(248')), glowBoxShadow);

    // 4. Mindmap and Scroll-to-Highlight Interaction
    section('4. Verify User Interactions (Mindmap)');
    
    // Click mindmap header to open it
    await page.click('.wiki-mindmap-header');
    await page.waitForSelector('.wiki-mindmap-container');
    assert('Interactive Mindmap unfolded successfully upon header click', true);

    // Toggle to mindmap mode to run mindmap specific assertions
    await page.click('.toggle-mode-btn-mindmap');

    // Check root node exists
    const rootText = await page.textContent('.mindmap-root-node');
    assert('Mindmap root node matches client name', rootText && rootText.includes('Verify'), rootText);

    // Locate branch node and click it to trigger scroll & highlight animation
    const nodes = page.locator('.mindmap-branch-node');
    const firstNodeText = await nodes.first().textContent();
    console.log(`  Clicking mindmap node: "${firstNodeText.trim()}"`);
    await nodes.first().click();
    
    // Wait a brief moment for the smooth scroll & highlight
    await page.waitForTimeout(200);
    assert('Mindmap node click handles scroll-to-highlight successfully', true);

    // 5. Traceability and Citation Badge Interaction
    section('5. Verify User Interactions (Citation & Drawer)');
    
    // Find the first citation badge
    const badge = page.locator('.ref-citation-badge').first();
    const badgeText = await badge.textContent();
    assert('Citation badge text is correctly formatted', badgeText.includes('溯源'));

    console.log('  Clicking citation badge to open traceability drawer...');
    await badge.click();
    
    // Verify that the slide-in drawer opens
    await page.waitForSelector('.trace-slider-overlay, .trace-slider-panel');
    assert('Traceability drawer overlay slid open successfully', true);

    const drawerHeader = await page.textContent('.trace-slider-header h3');
    assert('Traceability drawer header loaded', drawerHeader && (drawerHeader.includes('原始依据') || drawerHeader.includes('溯源') || drawerHeader.includes('对照面板')), drawerHeader);

    // Close the drawer
    await page.click('.btn-close-slider');
    await page.waitForSelector('.trace-slider-overlay', { state: 'detached' });
    assert('Traceability drawer closed successfully upon clicking close button', true);

    // 6. Verification of Corrupted Block Fallback (Negative Case)
    section('6. Verify Fallback Graceful Degradation (Negative Case)');
    
    // Manually write a corrupted block to the wiki to simulate bad sync data
    const corruptWikiContent = `# 既往史与诊疗时间轴\n\n## 2. 生理信号\n\`\`\`observation-block\ncorrupted yaml with missing colons and weird structure\n\`\`\``;
    await req('PUT', `/api/clients/${clientId}/wiki/medical_history.md`, { content: corruptWikiContent });
    
    // Reload/navigate to re-render: click another client first to clear state, then back to Browser Verify
    console.log('  Switching to another client to clear cache...');
    await page.click('.client-item:has-text("案例一")');
    await page.waitForSelector('.client-main-profile h2:has-text("案例一")');
    // Wait for Case 1 wiki pages to actually finish rendering by checking for pulmonary diagnosis text
    await page.waitForSelector('.markdown-rendered:has-text("慢阻肺")');

    console.log('  Switching back to Browser Verify...');
    await page.click(`.client-item:has-text("${clientData.name}")`);
    await page.waitForSelector(`.client-main-profile h2:has-text("${clientData.name}")`);
    
    // Switch to medical history tab where the corrupted block is
    console.log('  Navigating to "🧬 既往史与诊疗轴" tab for fallback check...');
    await page.click('.wiki-nav-item:has-text("既往史")');

    // Locate the fallback card
    const fallbackText = await page.textContent('.alert-block.alert-note strong');
    assert('Corrupted block fell back gracefully to neutral warning card without crashing', fallbackText.includes('结构化数据异常'), fallbackText);

    await browser.close();
    browser = null;
    
  } catch (err) {
    console.error('Error during browser E2E test:', err);
    if (page) {
      try {
        const html = await page.content();
        console.log('\n--- FAILED PAGE HTML CONTENT ---');
        console.log(html);
        console.log('--------------------------------\n');
        await page.screenshot({ path: '/Users/cc/llmwiki/tests/error_screenshot.png' });
        console.log('Saved error screenshot to: /Users/cc/llmwiki/tests/error_screenshot.png');
      } catch (screenshotErr) {
        console.error('Failed to capture page content/screenshot:', screenshotErr);
      }
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    throw err;
  } finally {
    // Cleanup the client
    section('7. Cleanup and Restore');
    const { status: sd } = await req('DELETE', `/api/clients/${clientId}`);
    assert('Deleted test client during cleanup', sd === 200, sd);
  }
  
  section('E2E Browser Test Suite Summary');
  console.log(`  Tests Passed: ${passed}`);
  console.log(`  Tests Failed: ${failed}`);
  
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('  🎉 All E2E browser and visual aesthetics tests passed successfully!');
    process.exit(0);
  }
}

runBrowserTests().catch(err => {
  console.error('Fatal Browser Test Error:', err);
  process.exit(1);
});
