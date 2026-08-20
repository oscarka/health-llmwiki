/**
 * generic_wiki/apiRoutes.cjs
 *
 * 通用 Wiki 记忆库 REST API 路由
 * 挂载至 server.cjs 的 /api/generic-wiki 前缀
 *
 * 接口列表：
 *   GET    /api/generic-wiki/domains                       - 列出所有 Domain
 *   POST   /api/generic-wiki/:domain/:entityId/init        - 初始化实体 Wiki
 *   GET    /api/generic-wiki/:domain/:entityId             - 读取全部页面
 *   GET    /api/generic-wiki/:domain/:entityId/:page       - 读取单页
 *   PUT    /api/generic-wiki/:domain/:entityId/:page       - 写入单页
 *   GET    /api/generic-wiki/:domain/:entityId/summary     - 获取记忆摘要（供 Agent 注入）
 *   GET    /api/generic-wiki/:domain                       - 列出 Domain 下所有实体
 *   POST   /api/generic-wiki/domains/register              - 注册新 Domain
 */

'use strict';

const express = require('express');
const router = express.Router();
const wiki = require('./wikiEngine.cjs');

// ─── 列出所有 Domain ──────────────────────────────────────────────────────────
router.get('/domains', (req, res) => {
  const domains = Object.entries(wiki.DOMAIN_REGISTRY).map(([id, def]) => ({
    id,
    description: def.description,
    default_pages: def.default_pages,
    legacy_path: def.legacy_path || false,
  }));
  res.json({ domains });
});

// ─── 注册新 Domain ────────────────────────────────────────────────────────────
router.post('/domains/register', (req, res) => {
  try {
    const { domain_id, description, default_pages } = req.body;
    if (!domain_id || !default_pages?.length) {
      return res.status(400).json({ error: 'domain_id 和 default_pages 为必填项' });
    }
    wiki.registerDomain(domain_id, { description: description || '', default_pages });
    res.status(201).json({ success: true, domain_id });
  } catch (err) {
    const status = err.message.includes('已存在') ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

// ─── 列出 Domain 下所有实体 ───────────────────────────────────────────────────
router.get('/:domain', (req, res) => {
  try {
    const entities = wiki.listDomainEntities(req.params.domain);
    res.json({ domain: req.params.domain, entities, total: entities.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── 初始化实体 Wiki ─────────────────────────────────────────────────────────
router.post('/:domain/:entityId/init', (req, res) => {
  try {
    const { domain, entityId } = req.params;
    const entityInfo = req.body || {};
    const created = wiki.createDomainWiki(domain, entityId, entityInfo);
    res.status(201).json({
      success: true,
      domain,
      entity_id: entityId,
      pages_created: Object.keys(created),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── 读取实体全部 Wiki 页面 ───────────────────────────────────────────────────
router.get('/:domain/:entityId', (req, res) => {
  // 避免与 /domains 路由冲突
  if (req.params.domain === 'domains') return res.status(400).json({ error: '保留路径' });

  try {
    const pages = wiki.readDomainWiki(req.params.domain, req.params.entityId);
    if (!pages) return res.status(404).json({ error: '实体 Wiki 不存在，请先调用 /init' });
    res.json({ domain: req.params.domain, entity_id: req.params.entityId, pages });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── 获取记忆摘要（供 Agent System Prompt 注入）────────────────────────────
router.get('/:domain/:entityId/summary', (req, res) => {
  try {
    const maxTokens = parseInt(req.query.max_tokens || '2000', 10);
    const summary = wiki.buildMemorySummary(req.params.domain, req.params.entityId, maxTokens);
    if (!summary) return res.status(404).json({ error: '实体 Wiki 不存在或为空' });
    res.json({
      domain: req.params.domain,
      entity_id: req.params.entityId,
      summary,
      char_count: summary.length,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── 读取单页 ─────────────────────────────────────────────────────────────────
router.get('/:domain/:entityId/:page', (req, res) => {
  if (req.params.page === 'summary') return; // 由上层路由处理

  try {
    const page = req.params.page.endsWith('.md') ? req.params.page : `${req.params.page}.md`;
    const content = wiki.readDomainWikiPage(req.params.domain, req.params.entityId, page);
    if (content === null) return res.status(404).json({ error: `页面 "${page}" 不存在` });
    res.json({ domain: req.params.domain, entity_id: req.params.entityId, page, content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── 写入单页 ─────────────────────────────────────────────────────────────────
router.put('/:domain/:entityId/:page', (req, res) => {
  try {
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: 'content 为必填项' });

    const page = req.params.page.endsWith('.md') ? req.params.page : `${req.params.page}.md`;
    wiki.writeDomainWikiPage(req.params.domain, req.params.entityId, page, content);
    res.json({ success: true, domain: req.params.domain, entity_id: req.params.entityId, page });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
