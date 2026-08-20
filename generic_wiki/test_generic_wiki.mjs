#!/usr/bin/env node
/**
 * test_generic_wiki.mjs
 * Phase 3 验收测试 — 通用 Wiki 记忆库引擎
 * 
 * 纯本地单元测试（不依赖网络，验证 wikiEngine.cjs 核心逻辑）
 * 测试范围：
 *   1. Domain 注册表完整性（health/social_ops/sales/hr_recruiting）
 *   2. Domain 隔离：新 Domain 不影响 health 路径
 *   3. createDomainWiki：正确创建默认页面
 *   4. readDomainWiki：读取全部页面
 *   5. readDomainWikiPage / writeDomainWikiPage：单页读写
 *   6. 路径穿越防护（../ 攻击）
 *   7. buildMemorySummary：生成供 Agent 注入的摘要
 *   8. listDomainEntities：列出实体
 *   9. registerDomain：动态注册新 Domain
 *  10. 健康 Domain 向后兼容性（legacy_path = true）
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;

function log(icon, label, detail = '') {
  console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    log('✅', name);
  } catch (err) {
    failed++;
    log('❌', name, err.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// ─── 临时目录隔离测试，不污染真实 /data/wiki ──────────────────────────────
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'generic_wiki_test_'));
process.env.WIKI_BASE_OVERRIDE = TMP_DIR;

// 通过 monkey-patch 方式注入临时目录，避免修改 wikiEngine.cjs 源码
const wikiEnginePath = path.resolve('/Users/cc/llmwiki/generic_wiki/wikiEngine.cjs');
// 临时修改数据目录到 tmp
const originalContent = fs.readFileSync(wikiEnginePath, 'utf-8');
const patchedContent = originalContent.replace(
  "path.join(__dirname, '..', 'data', 'wiki')",
  `'${TMP_DIR}'`
);
const tmpEnginePath = path.join(TMP_DIR, `wikiEngine_test_${Date.now()}.cjs`);
fs.writeFileSync(tmpEnginePath, patchedContent, 'utf-8');
const wiki = require(tmpEnginePath);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Phase 3 验收测试 — 通用 Wiki 记忆库引擎');
console.log(`  临时测试目录: ${TMP_DIR}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── 1. Domain 注册表完整性 ────────────────────────────────────────────────────
console.log('【1】Domain 注册表完整性');

await check('health Domain 存在', () => {
  assert('health' in wiki.DOMAIN_REGISTRY, 'health Domain 未注册');
  assert(wiki.DOMAIN_REGISTRY.health.legacy_path === true, 'health 应为 legacy_path');
});

await check('social_ops Domain 存在', () => {
  assert('social_ops' in wiki.DOMAIN_REGISTRY, 'social_ops Domain 未注册');
  assert(wiki.DOMAIN_REGISTRY.social_ops.default_pages.includes('index.md'), '应有 index.md');
});

await check('sales / hr_recruiting Domain 存在', () => {
  assert('sales' in wiki.DOMAIN_REGISTRY, 'sales 未注册');
  assert('hr_recruiting' in wiki.DOMAIN_REGISTRY, 'hr_recruiting 未注册');
});

// ── 2. 路径隔离验证 ───────────────────────────────────────────────────────────
console.log('\n【2】Domain 路径隔离');

await check('social_ops 路径包含 domain 前缀', () => {
  const dir = wiki.getWikiDir('social_ops', 'user_001');
  assert(dir.includes('social_ops'), `路径应含 social_ops: ${dir}`);
  assert(dir.includes('user_001'), `路径应含 user_001: ${dir}`);
});

await check('health 路径不含 domain 前缀（向后兼容）', () => {
  const dir = wiki.getWikiDir('health', 'client_001');
  assert(!dir.includes('health/'), `health 路径不应有 domain 前缀: ${dir}`);
  assert(dir.includes('client_001'), `路径应含 client_001: ${dir}`);
});

await check('social_ops 与 sales 路径完全隔离', () => {
  const opDir = wiki.getWikiDir('social_ops', 'same_id');
  const salesDir = wiki.getWikiDir('sales', 'same_id');
  assert(opDir !== salesDir, '不同 Domain 同一 ID 路径应不同');
  assert(!opDir.includes('sales'), 'social_ops 路径不应含 sales');
});

// ── 3. createDomainWiki ───────────────────────────────────────────────────────
console.log('\n【3】createDomainWiki — 初始化实体 Wiki');

await check('social_ops 创建默认页面', () => {
  const created = wiki.createDomainWiki('social_ops', 'user_g3_001', { name: '张小美' });
  assert(Object.keys(created).includes('index.md'), '应创建 index.md');
  assert(Object.keys(created).includes('preferences.md'), '应创建 preferences.md');
  assert(Object.keys(created).includes('interaction_log.md'), '应创建 interaction_log.md');
  assert(Object.keys(created).includes('conversion_record.md'), '应创建 conversion_record.md');
});

await check('index.md 包含实体名称', () => {
  const created = wiki.createDomainWiki('social_ops', 'user_g3_002', { name: '李大明' });
  assert(created['index.md'].includes('李大明'), `index.md 应含用户名: ${created['index.md'].slice(0, 100)}`);
});

await check('重复初始化不覆盖已有内容', () => {
  wiki.writeDomainWikiPage('social_ops', 'user_g3_001', 'index.md', '# 已有内容\n* 不应被覆盖');
  wiki.createDomainWiki('social_ops', 'user_g3_001', { name: '新名字' });
  const content = wiki.readDomainWikiPage('social_ops', 'user_g3_001', 'index.md');
  assert(content.includes('已有内容'), '重复 init 不应覆盖已有内容');
});

// ── 4. readDomainWiki ────────────────────────────────────────────────────────
console.log('\n【4】readDomainWiki — 读取全部页面');

await check('读取所有页面返回 object', () => {
  const pages = wiki.readDomainWiki('social_ops', 'user_g3_002');
  assert(pages !== null, '应返回页面对象');
  assert(typeof pages === 'object', '应为对象');
  assert('index.md' in pages, '应含 index.md');
});

await check('不存在的实体返回 null', () => {
  const pages = wiki.readDomainWiki('social_ops', 'nonexistent_user_xyz');
  assert(pages === null, '不存在的实体应返回 null');
});

// ── 5. 单页读写 ───────────────────────────────────────────────────────────────
console.log('\n【5】readDomainWikiPage / writeDomainWikiPage');

await check('写入后读取内容一致', () => {
  const testContent = '# 测试页面\n\n* 偏好：不喜欢打广告\n* 活跃时段：晚上9点-11点';
  wiki.writeDomainWikiPage('social_ops', 'user_g5_001', 'preferences.md', testContent);
  const read = wiki.readDomainWikiPage('social_ops', 'user_g5_001', 'preferences.md');
  assert(read === testContent, `读取内容不一致: ${read?.slice(0, 50)}`);
});

await check('读取不存在页面返回 null', () => {
  const content = wiki.readDomainWikiPage('social_ops', 'user_g5_001', 'nonexistent.md');
  assert(content === null, '不存在页面应返回 null');
});

// ── 6. 路径穿越防护 ───────────────────────────────────────────────────────────
console.log('\n【6】路径穿越防护（安全）');

await check('../ 路径穿越被拒绝（读取）', () => {
  try {
    wiki.readDomainWikiPage('social_ops', 'user_test_001', '../../../etc/passwd.md');
    throw new Error('应抛出错误');
  } catch (err) {
    assert(err.message.includes('非法页面名称'), `错误信息不正确: ${err.message}`);
  }
});

await check('../ 路径穿越被拒绝（写入）', () => {
  try {
    wiki.writeDomainWikiPage('social_ops', 'user_test_001', '../../hack.md', 'evil');
    throw new Error('应抛出错误');
  } catch (err) {
    assert(err.message.includes('非法页面名称'), `错误信息不正确: ${err.message}`);
  }
});

await check('非 .md 扩展名被拒绝', () => {
  try {
    wiki.readDomainWikiPage('social_ops', 'user_test_001', 'hack.sh');
    throw new Error('应抛出错误');
  } catch (err) {
    assert(err.message.includes('非法页面名称'), `错误信息不正确: ${err.message}`);
  }
});

// ── 7. buildMemorySummary ─────────────────────────────────────────────────────
console.log('\n【7】buildMemorySummary — 供 Agent 注入的记忆摘要');

await check('生成非空摘要', () => {
  wiki.createDomainWiki('social_ops', 'user_g7_001', { name: '测试用户' });
  const summary = wiki.buildMemorySummary('social_ops', 'user_g7_001');
  assert(summary.length > 0, '摘要不应为空');
  assert(summary.includes('index.md'), '摘要应包含 index.md 内容');
});

await check('摘要长度受 maxTokens 限制', () => {
  const summary = wiki.buildMemorySummary('social_ops', 'user_g7_001', 200);
  assert(summary.length <= 500, `摘要过长: ${summary.length} 字（限制 200 tokens）`);
});

await check('不存在实体返回空字符串', () => {
  const summary = wiki.buildMemorySummary('social_ops', 'nonexistent_entity');
  assert(summary === '', `应返回空字符串，实际: "${summary}"`);
});

// ── 8. listDomainEntities ────────────────────────────────────────────────────
console.log('\n【8】listDomainEntities — 列出 Domain 实体');

await check('列出 social_ops 实体', () => {
  const entities = wiki.listDomainEntities('social_ops');
  assert(Array.isArray(entities), '应返回数组');
  assert(entities.includes('user_g3_001'), `应含 user_g3_001，实际: ${entities.join(', ')}`);
  assert(entities.includes('user_g3_002'), `应含 user_g3_002`);
});

await check('未知 Domain 返回空数组', () => {
  const entities = wiki.listDomainEntities('nonexistent_domain_xyz');
  assert(Array.isArray(entities) && entities.length === 0, '未知 Domain 应返回空数组');
});

// ── 9. registerDomain ────────────────────────────────────────────────────────
console.log('\n【9】registerDomain — 动态注册新 Domain');

await check('注册新 Domain', () => {
  wiki.registerDomain('test_domain_xyz', {
    description: '测试用临时 Domain',
    default_pages: ['index.md', 'notes.md'],
  });
  assert('test_domain_xyz' in wiki.DOMAIN_REGISTRY, '新 Domain 应已注册');
  assert(wiki.DOMAIN_REGISTRY.test_domain_xyz.legacy_path === false, '新 Domain 应不是 legacy_path');
});

await check('重复注册同一 Domain 应抛出错误', () => {
  try {
    wiki.registerDomain('test_domain_xyz', { description: 'dup', default_pages: ['index.md'] });
    throw new Error('应抛出错误');
  } catch (err) {
    assert(err.message.includes('已存在'), `错误信息不正确: ${err.message}`);
  }
});

await check('非法 Domain ID 被拒绝', () => {
  try {
    wiki.registerDomain('INVALID DOMAIN!', { description: 'x', default_pages: ['index.md'] });
    throw new Error('应抛出错误');
  } catch (err) {
    assert(err.message !== '应抛出错误', `应拒绝非法 ID，实际: ${err.message}`);
  }
});

// ── 10. 健康 Domain 向后兼容 ─────────────────────────────────────────────────
console.log('\n【10】health Domain 向后兼容性');

await check('health Domain 路径不含 domain 子目录', () => {
  const dir = wiki.getWikiDir('health', 'legacy_client_001');
  // macOS /tmp is a symlink to /private/var — use string contains check instead of path.relative
  // health legacy_path should NOT have a 'health/' directory segment
  const normalized = dir.replace(/\/private\/var\//, '/var/');
  assert(!normalized.includes('/health/'), `健康路径不应含 /health/ 子目录，实际: ${dir}`);
  assert(dir.endsWith('legacy_client_001'), `路径应以 legacy_client_001 结尾，实际: ${dir}`);
});

// ─── 清理临时目录 ────────────────────────────────────────────────────────────
fs.rmSync(TMP_DIR, { recursive: true, force: true });

// ─── 汇总 ─────────────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  测试结果: ✅ ${passed} 通过  ❌ ${failed} 失败  (共 ${passed + failed} 项)`);
if (failed === 0) {
  console.log('  🎉 Phase 3 验收通过！可以进入 Phase 4。');
} else {
  console.log('  ⚠️  存在失败项，请修复后重新测试。');
  process.exit(1);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
