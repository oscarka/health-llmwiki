/**
 * generic_wiki/wikiEngine.cjs
 *
 * 通用 Wiki 记忆库引擎 — Domain 隔离架构
 *
 * 设计原则：
 *   - 健康管理 Domain（现有）与新 Agent Domain（social_ops、sales 等）完全隔离
 *   - 每个 Domain 有独立的 data/wiki/{domain}/{entityId}/ 目录
 *   - 每个 Domain 有独立的 page 模板（templates/）
 *   - 现有 /data/wiki/{clientId}/ 路径不受影响（健康 Domain = 'health'）
 *   - 新 Domain 通过 createDomainWiki() 初始化，不触碰健康数据目录
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WIKI_BASE = path.join(DATA_DIR, 'wiki');

// ─── Domain 注册表 ────────────────────────────────────────────────────────────
// 每个 Domain 定义其默认 Wiki 页面模板
// 现有健康 Domain 保持原样，新 Domain 在此注册
const DOMAIN_REGISTRY = {
  health: {
    description: '健康管理领域（现有系统，保持兼容）',
    default_pages: ['index.md', 'medical_history.md', 'medication_plan.md', 'communication_timeline.md', 'user_profile.md'],
    // 健康 Domain 使用原始路径（不加 domain 前缀，向后兼容）
    legacy_path: true,
  },
  social_ops: {
    description: '私域社群运营领域',
    default_pages: ['index.md', 'preferences.md', 'interaction_log.md', 'conversion_record.md'],
    legacy_path: false,
  },
  sales: {
    description: '销售与客户关系领域',
    default_pages: ['index.md', 'needs_analysis.md', 'follow_up.md', 'deal_record.md'],
    legacy_path: false,
  },
  hr_recruiting: {
    description: '人力资源与招聘领域',
    default_pages: ['index.md', 'candidate_profile.md', 'interview_record.md'],
    legacy_path: false,
  },
};

// ─── 路径解析 ─────────────────────────────────────────────────────────────────

/**
 * 获取实体的 Wiki 目录路径
 * - health Domain：/data/wiki/{entityId}/（向后兼容原路径）
 * - 其他 Domain：/data/wiki/{domain}/{entityId}/
 */
function getWikiDir(domain, entityId) {
  if (!DOMAIN_REGISTRY[domain]) {
    throw new Error(`未知 Domain: "${domain}"。可用: ${Object.keys(DOMAIN_REGISTRY).join(', ')}`);
  }
  if (DOMAIN_REGISTRY[domain].legacy_path) {
    return path.join(WIKI_BASE, entityId);
  }
  return path.join(WIKI_BASE, domain, entityId);
}

// ─── 模板加载 ─────────────────────────────────────────────────────────────────

function loadTemplate(domain, pageName, entityInfo = {}) {
  const templatePath = path.join(__dirname, 'templates', domain, pageName);
  if (fs.existsSync(templatePath)) {
    let content = fs.readFileSync(templatePath, 'utf-8');
    // 替换模板占位符
    for (const [key, val] of Object.entries(entityInfo)) {
      content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val || '');
    }
    return content;
  }
  // 无模板文件时使用内置默认模板
  return getBuiltinTemplate(domain, pageName, entityInfo);
}

function getBuiltinTemplate(domain, pageName, info = {}) {
  const name = info.name || '未知';
  const id = info.id || '';
  const now = new Date().toISOString().split('T')[0];

  const templates = {
    social_ops: {
      'index.md': `# 用户画像首页：${name}\n\n## 1. 核心标签\n* 待补充\n\n## 2. 偏好摘要\n* 待补充\n\n## 3. 互动总结\n* 首次接触：${now}\n`,
      'preferences.md': `# 偏好与兴趣记录\n\n## 产品偏好\n* 待记录\n\n## 沟通风格偏好\n* 待记录\n\n## 价格敏感度\n* 待记录\n`,
      'interaction_log.md': `# 互动记录摘要\n\n## 近期互动\n| 日期 | 渠道 | 主题 | 结果 |\n|------|------|------|------|\n| ${now} | — | 首次建档 | — |\n`,
      'conversion_record.md': `# 转化与成交记录\n\n## 询价记录\n* 暂无\n\n## 成交记录\n* 暂无\n\n## 流失/沉默记录\n* 暂无\n`,
    },
    sales: {
      'index.md': `# 客户档案：${name}\n\n## 需求摘要\n* 待补充\n\n## 决策阶段\n* 初始接触 — ${now}\n`,
      'needs_analysis.md': `# 需求分析\n\n## 明确需求\n* 待记录\n\n## 隐性需求\n* 待挖掘\n\n## 预算范围\n* 待确认\n`,
      'follow_up.md': `# 跟进记录\n\n| 日期 | 方式 | 内容摘要 | 下次跟进 |\n|------|------|----------|----------|\n| ${now} | — | 建档 | — |\n`,
      'deal_record.md': `# 成交与合同记录\n\n## 报价记录\n* 暂无\n\n## 合同记录\n* 暂无\n`,
    },
    hr_recruiting: {
      'index.md': `# 候选人档案：${name}\n\n## 基本信息\n* 建档日期：${now}\n\n## 当前状态\n* 初筛\n`,
      'candidate_profile.md': `# 候选人详细画像\n\n## 教育背景\n* 待补充\n\n## 工作经历\n* 待补充\n\n## 技能标签\n* 待补充\n`,
      'interview_record.md': `# 面试记录\n\n| 日期 | 轮次 | 面试官 | 评分 | 备注 |\n|------|------|--------|------|------|\n| — | — | — | — | 暂无 |\n`,
    },
  };

  return templates[domain]?.[pageName] || `# ${pageName}\n\n* 待补充\n`;
}

// ─── 核心 API ─────────────────────────────────────────────────────────────────

/**
 * 为实体初始化 Wiki（创建默认页面）
 * @param {string} domain - 领域标识
 * @param {string} entityId - 实体 ID
 * @param {object} entityInfo - 实体基本信息（用于填充模板）
 * @returns {object} 创建的页面内容映射
 */
function createDomainWiki(domain, entityId, entityInfo = {}) {
  const domainDef = DOMAIN_REGISTRY[domain];
  if (!domainDef) throw new Error(`未知 Domain: "${domain}"`);

  const wikiDir = getWikiDir(domain, entityId);
  fs.mkdirSync(wikiDir, { recursive: true });

  const created = {};
  for (const pageName of domainDef.default_pages) {
    const filePath = path.join(wikiDir, pageName);
    if (!fs.existsSync(filePath)) {
      const content = loadTemplate(domain, pageName, { ...entityInfo, id: entityId });
      fs.writeFileSync(filePath, content, 'utf-8');
      created[pageName] = content;
    }
  }

  console.log(`[GenericWiki] 已为 ${domain}/${entityId} 初始化 Wiki（${Object.keys(created).length} 页）`);
  return created;
}

/**
 * 读取实体的全部 Wiki 页面
 */
function readDomainWiki(domain, entityId) {
  const wikiDir = getWikiDir(domain, entityId);
  if (!fs.existsSync(wikiDir)) return null;

  const pages = {};
  for (const file of fs.readdirSync(wikiDir)) {
    if (file.endsWith('.md')) {
      pages[file] = fs.readFileSync(path.join(wikiDir, file), 'utf-8');
    }
  }
  return pages;
}

/**
 * 读取实体的单个 Wiki 页面
 */
function readDomainWikiPage(domain, entityId, pageName) {
  if (!pageName.endsWith('.md') || pageName.includes('..')) {
    throw new Error(`非法页面名称: "${pageName}"`);
  }
  const filePath = path.join(getWikiDir(domain, entityId), pageName);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * 写入实体的单个 Wiki 页面
 */
function writeDomainWikiPage(domain, entityId, pageName, content) {
  if (!pageName.endsWith('.md') || pageName.includes('..')) {
    throw new Error(`非法页面名称: "${pageName}"`);
  }
  const wikiDir = getWikiDir(domain, entityId);
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, pageName), content, 'utf-8');
}

/**
 * 为 Agent System Prompt 构建记忆摘要
 * 提取最重要的页面内容注入上下文（防止 token 爆炸）
 * @param {string} domain
 * @param {string} entityId
 * @param {number} maxTokens - 约等于字符数的近似上限
 * @returns {string} 格式化的记忆摘要
 */
function buildMemorySummary(domain, entityId, maxTokens = 2000) {
  const pages = readDomainWiki(domain, entityId);
  if (!pages) return '';

  const domainDef = DOMAIN_REGISTRY[domain];
  // 优先摘要 index.md（最重要），其次按 default_pages 顺序
  const orderedPages = domainDef.default_pages.filter(p => pages[p]);

  const parts = [];
  let totalLen = 0;

  for (const pageName of orderedPages) {
    const content = pages[pageName];
    if (!content) continue;

    // 截取页面内容（防止单页过长）
    const maxPerPage = Math.floor(maxTokens / orderedPages.length);
    const excerpt = content.length > maxPerPage
      ? content.slice(0, maxPerPage) + '\n...(更多内容省略)'
      : content;

    parts.push(`\n## [${pageName}]\n${excerpt}`);
    totalLen += excerpt.length;

    if (totalLen >= maxTokens) break;
  }

  if (parts.length === 0) return '';
  return `\n\n---\n# 用户记忆档案（${domain} Domain）\n${parts.join('\n')}\n---\n`;
}

/**
 * 列出指定 Domain 下的所有实体 ID
 */
function listDomainEntities(domain) {
  const domainDef = DOMAIN_REGISTRY[domain];
  if (!domainDef) return [];

  const baseDir = domainDef.legacy_path ? WIKI_BASE : path.join(WIKI_BASE, domain);
  if (!fs.existsSync(baseDir)) return [];

  return fs.readdirSync(baseDir).filter(name => {
    const stat = fs.statSync(path.join(baseDir, name));
    return stat.isDirectory();
  });
}

/**
 * 注册新 Domain（运行时动态扩展）
 */
function registerDomain(domainId, config) {
  if (DOMAIN_REGISTRY[domainId]) {
    throw new Error(`Domain "${domainId}" 已存在`);
  }
  if (!/^[a-z0-9_]{2,32}$/.test(domainId)) {
    throw new Error(`Domain ID 只允许小写字母、数字和下划线（2~32位）`);
  }
  DOMAIN_REGISTRY[domainId] = { ...config, legacy_path: false };
  console.log(`[GenericWiki] 已注册新 Domain: "${domainId}"`);
}

module.exports = {
  createDomainWiki,
  readDomainWiki,
  readDomainWikiPage,
  writeDomainWikiPage,
  buildMemorySummary,
  listDomainEntities,
  registerDomain,
  DOMAIN_REGISTRY,
  getWikiDir,
};
