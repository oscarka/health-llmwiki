const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { Pool } = require('pg');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ──────────────────── 前端静态文件 ────────────────────
const DIST_DIR = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
}

// ──────────────────── Supabase / PostgreSQL 连接 ────────────────────
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:lnZbMyimxpMYgUp5@db.feaeonavsqzewadgoqeh.supabase.co:5432/postgres';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('supabase.co') ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

// ── DB helper（所有 SQL 都在 llmwiki schema）────────────────────────
const db = {
  query: async (sql, params) => {
    const client = await pool.connect();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  },
};

// ──────────────────── 数据访问层（替代文件读写）────────────────────

const readClients = async () => {
  const res = await db.query(
    `SELECT id, name, age, gender, phone, allergies,
            created_at AS "createdAt", last_sync_at AS "lastSyncAt"
     FROM llmwiki.clients ORDER BY created_at DESC`,
    []
  );
  return res.rows;
};

const findClient = async (id) => {
  const res = await db.query(
    `SELECT id, name, age, gender, phone, allergies,
            created_at AS "createdAt", last_sync_at AS "lastSyncAt"
     FROM llmwiki.clients WHERE id=$1`,
    [id]
  );
  return res.rows[0] || null;
};

const createClient = async ({ id, name, age, gender, phone, allergies }) => {
  const res = await db.query(
    `INSERT INTO llmwiki.clients (id, name, age, gender, phone, allergies)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id  -- 幂等：已存在则返回现有行
     RETURNING id, name, age, gender, phone, allergies,
               created_at AS "createdAt", last_sync_at AS "lastSyncAt"`,
    [id, name, age || null, gender || null, phone || null, allergies || null]
  );
  return res.rows[0];
};

const updateClientMeta = async (id, fields) => {
  const setClauses = [];
  const vals = [id];
  if (fields.name      !== undefined) { vals.push(fields.name);      setClauses.push(`name=$${vals.length}`); }
  if (fields.age       !== undefined) { vals.push(fields.age);       setClauses.push(`age=$${vals.length}`); }
  if (fields.gender    !== undefined) { vals.push(fields.gender);    setClauses.push(`gender=$${vals.length}`); }
  if (fields.phone     !== undefined) { vals.push(fields.phone);     setClauses.push(`phone=$${vals.length}`); }
  if (fields.allergies !== undefined) { vals.push(fields.allergies); setClauses.push(`allergies=$${vals.length}`); }
  if (fields.lastSyncAt !== undefined) { vals.push(fields.lastSyncAt); setClauses.push(`last_sync_at=$${vals.length}`); }
  if (setClauses.length === 0) return findClient(id);
  setClauses.push(`updated_at=${Date.now()}`);
  const res = await db.query(
    `UPDATE llmwiki.clients SET ${setClauses.join(',')} WHERE id=$1
     RETURNING id, name, age, gender, phone, allergies,
               created_at AS "createdAt", last_sync_at AS "lastSyncAt"`,
    vals
  );
  return res.rows[0];
};

const deleteClientData = async (id) => {
  // CASCADE 会自动删除 wiki_pages / client_logs / sync_history
  await db.query('DELETE FROM llmwiki.clients WHERE id=$1', [id]);
};

const readWikiPages = async (clientId) => {
  const res = await db.query(
    'SELECT page_name, content FROM llmwiki.wiki_pages WHERE client_id=$1',
    [clientId]
  );
  const pages = {};
  res.rows.forEach(r => { pages[r.page_name] = r.content; });
  return pages;
};

const writeWikiPages = async (clientId, pages) => {
  for (const [pageName, content] of Object.entries(pages)) {
    if (!pageName.endsWith('.md')) continue;
    await db.query(
      `INSERT INTO llmwiki.wiki_pages (client_id, page_name, content, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_id, page_name)
       DO UPDATE SET content=EXCLUDED.content, updated_at=EXCLUDED.updated_at`,
      [clientId, pageName, content, Date.now()]
    );
  }
};

const readLogs = async (clientId) => {
  const res = await db.query(
    `SELECT id, type, title, content, source, synced,
            created_at AS timestamp
     FROM llmwiki.client_logs WHERE client_id=$1 ORDER BY created_at ASC`,
    [clientId]
  );
  return res.rows.map(r => ({
    ...r,
    timestamp: new Date(Number(r.timestamp)).toISOString(),
    synced: Boolean(r.synced),
  }));
};

const appendLog = async (clientId, log) => {
  const res = await db.query(
    `INSERT INTO llmwiki.client_logs (id, client_id, type, title, content, source, synced, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, type, title, content, source, synced, created_at AS timestamp`,
    [log.id, clientId, log.type, log.title || null, log.content,
     log.source || null, false, log.created_at || Date.now()]
  );
  const r = res.rows[0];
  return { ...r, timestamp: new Date(Number(r.timestamp)).toISOString(), synced: false };
};

const markLogsSynced = async (logIds) => {
  if (!logIds || logIds.length === 0) return;
  await db.query(
    `UPDATE llmwiki.client_logs SET synced=TRUE WHERE id=ANY($1)`,
    [logIds]
  );
};

const readSyncHistory = async (clientId) => {
  const res = await db.query(
    `SELECT id, log_ids, summary, created_at
     FROM llmwiki.sync_history WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [clientId]
  );
  return res.rows.map(r => ({
    ...r,
    log_ids: r.log_ids ? JSON.parse(r.log_ids) : [],
    timestamp: new Date(Number(r.created_at)).toISOString(),
  }));
};

const appendSyncHistory = async (clientId, entry) => {
  await db.query(
    `INSERT INTO llmwiki.sync_history (client_id, log_ids, summary, created_at)
     VALUES ($1,$2,$3,$4)`,
    [clientId, JSON.stringify(entry.logIds || []), JSON.stringify(entry), Date.now()]
  );
};

// ──────────────────── 默认 Wiki 模板（PRD 8分区认知骨架）────────────────────
const createDefaultWiki = (client) => {
  const ageStr = client.age ? `${client.age}岁` : '未知年龄';
  const genderStr = client.gender || '未知性别';
  return {
    'index.md': `# 客户健康首页：${client.name}

## 1. 当前主要关注 (Current Key Concerns)
*(此处由 AI 自动汇总最近最需要关注的健康信号，无原始记录时请手动录入)*
* 暂无 AI 汇总关注项，请录入第一条沟通记录后同步 Wiki。

## 2. 事件时间轴 (Timeline)
*(按时间倒序排列重要健康事件，AI 将在每次同步后自动追加)*
| 日期 | 事件类型 | 摘要 |
|------|----------|------|
| — | — | 暂无记录 |

## 3. 客户基本画像
* **基本信息**：${genderStr}，${ageStr}，电话：${client.phone || '未录入'}。
* **主要诊断**：待大模型汇总录入。
* **近期主要健康主诉**：暂无记录。

## 4. 快捷导航
* [既往史与诊疗时间轴](medical_history.md)
* [用药方案与生活医嘱](medication_plan.md)
* [随访互动摘要](communication_timeline.md)
`,
    'medical_history.md': `# 既往史与诊疗时间轴

## 1. 既往病史
* **慢性病**：暂无登记。
* **手术/外伤史**：暂无登记。
* **家族史**：暂无登记。

## 2. 生理信号 (Physiologic Signals)
*(心率、血压、血氧、体温、HRV等穿戴/检测数据)*
| 日期 | 指标 | 数值 | 参考范围 | 状态 |
|------|------|------|----------|------|
| — | — | — | — | — |

## 3. 化验结果 (Laboratory Findings)
*(血常规、生化、影像学、病理等实验室检查结果)*
| 日期 | 检查项目 | 结果 | 参考值 | 异常标记 |
|------|----------|------|--------|----------|
| — | — | — | — | — |

## 4. 功能变化 (Functional Changes)
*(活动能力、睡眠、认知、情绪、日常生活功能的主观与客观变化)*
* 暂无记录。

## 5. 诊疗轨迹时间轴
*(以下内容将随医生问诊及单证 OCR 录入由大模型自动追加并精简)*
暂无记录。
`,
    'medication_plan.md': `# 用药方案与生活医嘱

## 1. 当前干预措施 (Active Interventions)
*(当前正在执行的用药、手术、物理治疗、营养干预等)*
| 干预类型 | 具体内容 | 剂量/频次 | 开始日期 | 负责医生 |
|----------|----------|-----------|----------|----------|
| 用药 | 暂无记录 | — | — | — |

## 2. 当前用药方案
暂无记录。

## 3. 生活指导及预防建议
暂无记录。

> [!TIP]
> 💡 **生活医嘱提示**：以下由医生/健康管理师下达的生活指导将在沟通记录同步后自动汇总至此处。
`,
    'communication_timeline.md': `# 随访互动与沟通摘要

## 1. 互动摘要时间线
*(这里记录企微、电话、视频沟通的核心简报，帮助快速了解最近联系动态)*
暂无记录。

## 2. 监测目标 (Monitoring Targets)
*(当前阶段需要重点监测的指标和随访频率)*
| 监测指标 | 目标范围 | 监测频率 | 状态 |
|----------|----------|----------|------|
| — | — | — | 暂无设定 |

## 3. 原始溯源证据 (Source Evidence)
*(每条 Wiki 内容都应能追溯至原始沟通记录、影像单据或穿戴数据)*

**溯源引用格式**：在 Wiki 内容中使用 \`[🔗 溯源](log_id)\` 标记，点击可查看原始记录。

例如：
* 患者反映血压偏高 (158/98 mmHg) [🔗 溯源](log_示例ID)
* 化验单提示 LDL-C 升高 [🔗 溯源](log_示例ID)

> [!NOTE]
> 📋 **溯源规则**：AI 在更新 Wiki 时应为每条关键观察挂载对应的溯源引用，保证每条信息都可回溯至原始证据。
`,
    'user_profile.md': `# 用户画像与沟通注意点

## 基本背景
<!-- 年龄段、性别、职业背景等有助于沟通的非医疗信息 -->
暂无记录。

## 沟通偏好
<!-- 用户惯用语言（普通话/方言/专业术语程度）、偏好简洁还是详细解释 -->
暂无记录。

## 必须注意事项
<!-- 对AI不能说的内容、禁忌话题、特殊敏感点 -->
暂无记录。

## 个人与社会属性
<!-- 家庭状况、主要照护者、经济情况、城市、医保类型等影响建议的背景 -->
暂无记录。
`
  };
};


// ──────────────────── 辅助：context-inject 注入逻辑 ────────────────────

// 判断 user_profile.md 是否有真实内容（排除纯模板占位符）
const hasMeaningfulProfileContent = (profile) => {
  if (!profile) return false;
  // 去除 HTML 注释、「暂无记录」、空行、标题行（# 开头）
  const stripped = profile
    .replace(/<!--[\s\S]*?-->/g, '')   // 去除 HTML 注释
    .replace(/^#+\s.*$/gm, '')         // 去除 Markdown 标题
    .replace(/^暂无记录。?$/gm, '')    // 去除占位文字
    .replace(/\s+/g, ' ')              // 折叠空白
    .trim();
  return stripped.length > 20;         // 超过20字视为有实质内容
};

const estimateTokens = (text) => {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 0.6 + otherChars * 0.25);
};

const buildHealthContext = (wikiPages) => {
  const indexContent = wikiPages['index.md'] || '';
  const toolHint = `
---
📋 **可按需调用以下工具获取更多档案**（如用户询问具体用药、化验详情时调用）：
- 历史病史/化验/生理信号 → 工具 \`get_medical_history\`
- 当前用药方案/护理要程/监测目标 → 工具 \`get_medication_plan\`
（最近30轮对话记录已在对话历史中，无需重复读取）`;
  return indexContent + toolHint;
};

function splitWikiSections(wikiPages) {
  const sections = [];
  const skipPages = ['user_profile.md'];
  for (const [filename, content] of Object.entries(wikiPages)) {
    if (skipPages.includes(filename) || !content) continue;
    const parts = content.split(/(?=^## )/m);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.length < 20) continue;
      const titleMatch = trimmed.match(/^##?\s+(.+)/);
      const title = titleMatch ? titleMatch[1].trim() : '(无标题)';
      sections.push({ filename, title, content: trimmed, charCount: trimmed.length });
    }
  }
  return sections;
}

function scoreSection(section, queryTerms) {
  const text = (section.content + ' ' + section.filename).toLowerCase();
  let score = 0;
  let matchCount = 0;
  for (const term of queryTerms) {
    if (!term || term.length < 1) continue;
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = text.match(regex);
    if (matches) {
      matchCount += matches.length;
      score += matches.length / Math.sqrt(section.charCount);
    }
  }
  const titleLower = section.title.toLowerCase();
  for (const term of queryTerms) {
    if (term && titleLower.includes(term)) score += 2.0;
  }
  return { ...section, score, matchCount };
}

function tokenizeQuery(query) {
  const terms = [];
  const englishWords = query.match(/[a-zA-Z0-9]+/g) || [];
  terms.push(...englishWords.map(w => w.toLowerCase()));
  const chineseSegments = query.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of chineseSegments) {
    if (seg.length <= 2) {
      terms.push(seg);
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        terms.push(seg.substring(i, i + 2));
      }
      if (seg.length <= 6) terms.push(seg);
    }
  }
  return [...new Set(terms)];
}

function prefetchRelevantSections(wikiPages, query, topN = 6) {
  const sections = splitWikiSections(wikiPages);
  if (sections.length === 0) return [];
  const queryTerms = tokenizeQuery(query);
  if (queryTerms.length === 0) return [];
  return sections
    .map(s => scoreSection(s, queryTerms))
    .filter(s => s.matchCount > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

function buildPrefetchContext(wikiPages, query) {
  const sections = prefetchRelevantSections(wikiPages, query, 6);
  if (sections.length === 0) return buildHealthContext(wikiPages);
  const header = `📌 **以下是与当前问题最相关的健康档案片段**（共 ${sections.length} 段，按相关性排序）：\n`;
  const body = sections.map((s, i) =>
    `### [${i + 1}] ${s.filename} › ${s.title}\n${s.content}`
  ).join('\n\n---\n\n');
  const toolHint = `\n---\n📋 **如需更多详情可调用工具**：\n- \`get_medical_history\` → 完整历史病史\n- \`get_medication_plan\` → 完整用药方案`;
  return header + body + toolHint;
}

// ──────────────────── 健壮 JSON 解析 ────────────────────
const robustParseJson = (str) => {
  let cleaned = str.trim();
  if (cleaned.startsWith('```')) {
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) cleaned = match[1].trim();
  }
  try { return JSON.parse(cleaned); } catch (e) {
    console.warn('[robustParseJson] 初始解析失败，尝试修复...', e.message);
  }
  let inString = false, escape = false, stack = [], repaired = '';
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    repaired += char;
    if (escape) { escape = false; continue; }
    if (char === '\\') { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (char === ']' && stack[stack.length - 1] === '[') stack.pop();
    }
  }
  if (inString) repaired += '"';
  while (stack.length > 0) {
    const open = stack.pop();
    if (open === '{') repaired += '}';
    if (open === '[') repaired += ']';
  }
  try { return JSON.parse(repaired); } catch (e2) {
    try {
      const sanitized = repaired.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, p1) =>
        '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
      );
      return JSON.parse(sanitized);
    } catch (e3) {
      throw new Error(`JSON 解析及修复失败: ${e2.message}`);
    }
  }
};


// ──────────────────── REST APIs ────────────────────

// 1. 获取所有客户列表
app.get('/api/clients', async (req, res) => {
  try {
    const clients = await readClients();
    res.json(clients);
  } catch (err) {
    console.error('[GET /clients]', err);
    res.status(500).json({ error: '获取客户列表失败: ' + err.message });
  }
});

// 2. 创建客户
app.post('/api/clients', async (req, res) => {
  try {
    const { id: externalId, name, age, gender, phone, allergies } = req.body;
    if (!name) return res.status(400).json({ error: '姓名是必填项' });

    const clientId = externalId || `client_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // 幂等：已存在直接返回
    const existing = await findClient(clientId);
    if (existing) return res.status(200).json(existing);

    const newClient = await createClient({
      id: clientId, name,
      age: age ? parseInt(age) : null,
      gender, phone, allergies
    });

    // 初始化默认 Wiki
    const defaultWiki = createDefaultWiki(newClient);
    await writeWikiPages(newClient.id, defaultWiki);

    console.log(`[CreateClient] 新建客户 id=${clientId} name=${name} external=${!!externalId}`);
    res.status(201).json(newClient);
  } catch (err) {
    console.error('[POST /clients]', err);
    res.status(500).json({ error: '创建客户失败: ' + err.message });
  }
});

// 3. 更新客户基本信息
app.put('/api/clients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, age, gender, phone, allergies } = req.body;

    const client = await findClient(id);
    if (!client) return res.status(404).json({ error: '客户不存在' });

    const updated = await updateClientMeta(id, {
      name: name || client.name,
      age: age !== undefined ? parseInt(age) : client.age,
      gender: gender !== undefined ? gender : client.gender,
      phone: phone !== undefined ? phone : client.phone,
      allergies: allergies !== undefined ? allergies : client.allergies,
    });
    res.json(updated);
  } catch (err) {
    console.error('[PUT /clients/:id]', err);
    res.status(500).json({ error: '更新客户失败: ' + err.message });
  }
});

// 4. 删除客户
app.delete('/api/clients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const client = await findClient(id);
    if (!client) return res.status(404).json({ error: '客户不存在' });

    await deleteClientData(id); // CASCADE 删除关联数据
    res.json({ success: true, message: '客户及相关 Wiki 档案已成功删除' });
  } catch (err) {
    console.error('[DELETE /clients/:id]', err);
    res.status(500).json({ error: '删除客户失败: ' + err.message });
  }
});

// 5. 获取客户 Wiki 的所有页面
app.get('/api/clients/:id/wiki', async (req, res) => {
  try {
    const { id } = req.params;
    if (!await findClient(id)) return res.status(404).json({ error: '客户不存在' });
    const wikiPages = await readWikiPages(id);
    res.json(wikiPages);
  } catch (err) {
    console.error('[GET /clients/:id/wiki]', err);
    res.status(500).json({ error: '获取 Wiki 失败: ' + err.message });
  }
});

// 5b. Agent 专用：context-inject
app.get('/api/clients/:id/context-inject', async (req, res) => {
  try {
    const { id } = req.params;
    const query = req.query.query || '';
    const client = await findClient(id);
    if (!client) return res.status(404).json({ error: '客户不存在' });

    const wikiPages = await readWikiPages(id);
    const rawProfile = wikiPages['user_profile.md'] || '';
    // 只在有实质内容时才传出 user_profile，避免把空模板（HTML注释+暂无记录）传给 AI
    const userProfile = hasMeaningfulProfileContent(rawProfile) ? rawProfile : '';

    if (!client.lastSyncAt) {
      const brief = client.allergies ? `⚠️ 过敏史：${client.allergies}` : '';
      return res.json({
        user_profile: userProfile,
        health_wiki: brief,
        mode: 'new_user',
        token_estimate: {
          user_profile: estimateTokens(userProfile),
          health_wiki: estimateTokens(brief),
          total: estimateTokens(userProfile) + estimateTokens(brief)
        }
      });
    }

    const usePrefetch = query.trim().length > 0;
    const healthWiki = usePrefetch
      ? buildPrefetchContext(wikiPages, query)
      : buildHealthContext(wikiPages);

    res.json({
      user_profile: userProfile,
      health_wiki: healthWiki,
      mode: usePrefetch ? 'prefetch' : 'full',
      token_estimate: {
        user_profile: estimateTokens(userProfile),
        health_wiki: estimateTokens(healthWiki),
        total: estimateTokens(userProfile) + estimateTokens(healthWiki)
      }
    });
  } catch (err) {
    console.error('[GET /clients/:id/context-inject]', err);
    res.status(500).json({ error: '获取 context 失败: ' + err.message });
  }
});

// 6. 保存/修改单个 Wiki 页面
app.put('/api/clients/:id/wiki/:pageName', async (req, res) => {
  try {
    const { id, pageName } = req.params;
    const { content } = req.body;

    if (!await findClient(id)) return res.status(404).json({ error: '客户不存在' });
    if (!pageName.endsWith('.md')) return res.status(400).json({ error: '仅支持保存 .md 格式的 Wiki 页面' });
    if (pageName.includes('..') || pageName.includes('/') || pageName.includes('\\'))
      return res.status(400).json({ error: '页面名称不合法' });

    await writeWikiPages(id, { [pageName]: content });
    res.json({ success: true, message: `页面 ${pageName} 保存成功` });
  } catch (err) {
    console.error('[PUT /clients/:id/wiki/:pageName]', err);
    res.status(500).json({ error: '保存 Wiki 页面失败: ' + err.message });
  }
});

// 7. 获取客户的原始日志
app.get('/api/clients/:id/logs', async (req, res) => {
  try {
    const { id } = req.params;
    if (!await findClient(id)) return res.status(404).json({ error: '客户不存在' });
    const logs = await readLogs(id);
    res.json(logs);
  } catch (err) {
    console.error('[GET /clients/:id/logs]', err);
    res.status(500).json({ error: '获取日志失败: ' + err.message });
  }
});

// 8. 录入一条新的原始沟通日志
app.post('/api/clients/:id/logs', async (req, res) => {
  try {
    const { id } = req.params;
    const { type, content, title } = req.body;
    if (!type || !content) return res.status(400).json({ error: '类型和内容为必填项' });

    const VALID_LOG_TYPES = ['phone', 'video', 'wechat', 'ocr'];
    if (!VALID_LOG_TYPES.includes(type))
      return res.status(400).json({ error: `日志类型无效，必须是以下之一: ${VALID_LOG_TYPES.join(', ')}` });

    if (!await findClient(id)) return res.status(404).json({ error: '客户不存在' });

    const randomSuffix = Math.random().toString(36).substring(2, 6);
    const newLog = {
      id: `log_${Date.now()}_${randomSuffix}`,
      type,
      title: title || `${type === 'phone' ? '电话问诊' : type === 'video' ? '视频问诊' : type === 'wechat' ? '企微记录' : '单证OCR'} (${new Date().toLocaleDateString()})`,
      content,
      created_at: Date.now(),
    };

    const saved = await appendLog(id, newLog);
    res.status(201).json(saved);
  } catch (err) {
    console.error('[POST /clients/:id/logs]', err);
    res.status(500).json({ error: '录入日志失败: ' + err.message });
  }
});

// 8b. 批量录入多条沟通日志
app.post('/api/clients/:id/logs/batch', async (req, res) => {
  try {
    const { id } = req.params;
    const { logs: inputLogs } = req.body;

    if (!Array.isArray(inputLogs) || inputLogs.length === 0)
      return res.status(400).json({ error: 'logs 字段必须是非空数组' });

    if (!await findClient(id)) return res.status(404).json({ error: '客户不存在' });

    const VALID_LOG_TYPES = ['phone', 'video', 'wechat', 'ocr'];
    const insertedIds = [];
    const errors = [];

    for (let i = 0; i < inputLogs.length; i++) {
      const { type, content, title } = inputLogs[i];
      if (!type || !content) { errors.push(`第${i + 1}条缺少 type 或 content`); continue; }
      if (!VALID_LOG_TYPES.includes(type)) { errors.push(`第${i + 1}条 type 无效: ${type}`); continue; }

      const randomSuffix = Math.random().toString(36).substring(2, 6);
      const newLog = {
        id: `log_${Date.now()}_${randomSuffix}`,
        type,
        title: title || `批量录入-${type} (${new Date().toLocaleDateString()})`,
        content,
        created_at: Date.now(),
      };
      await appendLog(id, newLog);
      insertedIds.push(newLog.id);
    }

    res.status(201).json({
      success: true,
      inserted: insertedIds.length,
      ids: insertedIds,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (err) {
    console.error('[POST /clients/:id/logs/batch]', err);
    res.status(500).json({ error: '批量录入失败: ' + err.message });
  }
});

// ──────────────────── LLM 增量汇总逻辑 ────────────────────

let _openaiClient = null;
function getOpenAI() {
  if (!_openaiClient) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.ARK_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY 或 ARK_API_KEY 环境变量未设置');
    const baseURL = process.env.GEMINI_API_KEY
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
      : (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3');
    console.log(`[LLM] 使用 ${process.env.GEMINI_API_KEY ? 'Gemini' : 'Doubao'} baseURL=${baseURL}`);
    _openaiClient = new OpenAI({ apiKey, baseURL });
  }
  return _openaiClient;
}

// 9. Wiki 同步（多阶段 AI Pipeline）
app.post('/api/clients/:id/sync', async (req, res) => {
  const { id } = req.params;
  const syncStartTime = Date.now();

  try {
    const client = await findClient(id);
    if (!client) return res.status(404).json({ error: '客户不存在' });

    const allLogs = await readLogs(id);
    const unsyncedLogs = allLogs.filter(l => !l.synced);

    if (unsyncedLogs.length === 0) {
      return res.json({ message: '没有待同步的日志', wikiUpdated: false });
    }

    const currentWiki = await readWikiPages(id);

    // ── Stage 1: Fact Parse & Categorization ──
    const s1Start = Date.now();
    console.log(`[Stage 1] Extracting clinical facts from ${unsyncedLogs.length} logs for client ${id}...`);

    const stage1Prompt = `你是一个非常专业且细心的医疗事实提取助手。请从下面新增的沟通记录中提取所有的临床观察、医疗干预事实，以及用户画像信息（例如：新增诊断、主诉症状、生理指标数值、化验/CT检查结果、用药变更、留置管道、护理措施、沟通偏好、个人背景等）。
严禁凭空编造事实或添加沟通记录中未提及的内容。对于每一条事实，必须明确匹配其来自哪一条沟通记录的 ID。

请将提取的事实分类为：
1. "observation"：临床观察，包括：
   - "signal"：基础生理信号数值（血压、心率、呼吸、体温、血氧、血糖、HRV 等具体数字）
   - "finding"：检查检验结果（化验单、影像CT/X光/MRI、病理检查等）
   - "functional"：患者活动、睡眠、认知、语言、神志、瘫痪或反射异常等功能状态变化
2. "intervention"：医疗干预，包括：
   - "treatment"：药物治疗、用药变更、输液、手术等
   - "pipeline"：留置管道（气管插管、深静脉置管、胃管、尿管等）
   - "protection"：安全约束、防坠床防护等
   - "care"：体位护理、翻身排痰、皮肤护理、饮食限制等
3. "user_profile"：用户画像信息（非医疗事实，而是关于用户本人的沟通/背景信息），包括：
   - "preference"：沟通偏好（如"请简短回答"、"我喜欢详细解释"、"不要用专业术语"）
   - "background"：个人背景（如"我老公是医生"、"我在北京"、"我是护士"、"我不懂医学"）
   - "taboo"：禁忌内容（如"不要提住院"、"家人不知道病情"、"不要说癌症"）
   - "social"：个人社会属性（如主要照护者是谁、家庭状况、医保情况、经济考量）

新增沟通记录内容如下：
${unsyncedLogs.map(log => `
[ID: ${log.id}] [类型: ${log.type}] [标题: ${log.title}] [时间: ${log.timestamp}]
内容: 
${log.content}
`).join('\n\n')}

请直接输出一个合法的 JSON 对象，格式必须符合以下示例，不要有任何 Markdown 代码块包裹或解释性前缀后缀：
{
  "facts": [
    {
      "type": "observation",
      "subtype": "signal",
      "content": "血压 198/112 mmHg",
      "log_id": "log_..."
    },
    {
      "type": "observation",
      "subtype": "functional",
      "content": "神志呈嗜睡/浅昏迷状态，右侧肢体肌力 0 级",
      "log_id": "log_..."
    },
    {
      "type": "intervention",
      "subtype": "treatment",
      "content": "静脉滴注甘露醇 250ml",
      "log_id": "log_..."
    },
    {
      "type": "user_profile",
      "subtype": "preference",
      "content": "用户希望用简单易懂的语言解释，不要太多专业术语",
      "log_id": "log_..."
    },
    {
      "type": "user_profile",
      "subtype": "background",
      "content": "用户的丈夫是骨科医生，有一定医学基础",
      "log_id": "log_..."
    }
  ]
}`;

    const stage1Response = await getOpenAI().chat.completions.create({
      model: process.env.SYNC_MODEL || 'gemini-3.6-flash',
      messages: [
        { role: 'system', content: 'You are a professional assistant that outputs strict JSON only. Do not include markdown codeblocks or extra text.' },
        { role: 'user', content: stage1Prompt }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const stage1Content = stage1Response.choices[0]?.message?.content || '{}';
    let parsedFactsObj;
    try {
      parsedFactsObj = robustParseJson(stage1Content);
    } catch (e) {
      console.error('[Stage 1] JSON 解析失败:', stage1Content);
      throw new Error('临床事实提取失败：' + e.message);
    }

    const facts = parsedFactsObj.facts || [];
    console.log(`[Stage 1] ✓ 完成 (${Date.now() - s1Start}ms, ${facts.length} 条事实)`);

    // ── Stage 2: Heuristic-based Attention Scoring ──
    const s2Start = Date.now();
    console.log('[Stage 2] Calculating attention scores for observations...');
    facts.forEach(fact => {
      if (fact.type === 'observation') {
        let score = 0.3; // 默认基础分
        const text = fact.content.toLowerCase();

        // 1. 血氧饱和度 (SpO2) 异常
        const spo2Match = text.match(/(?:spo2|血氧饱和度|血氧)\s*(?:[<≤：:]\s*|仅|是|为)?\s*(\d+)%/i);
        if (spo2Match) {
          const val = parseInt(spo2Match[1]);
          if (val < 90) score = Math.max(score, 0.95);
          else if (val < 95) score = Math.max(score, 0.7);
        }

        // 2. 血压异常
        const bpMatch = text.match(/(\d{3})\s*\/\s*(\d{2,3})/);
        if (bpMatch) {
          const sys = parseInt(bpMatch[1]);
          const dia = parseInt(bpMatch[2]);
          if (sys >= 180 || dia >= 110) score = Math.max(score, 0.9);
          else if (sys >= 140 || dia >= 90) score = Math.max(score, 0.6);
        }

        // 3. 血糖异常
        const glucoseMatch = text.match(/(?:血糖|指尖血糖|空腹血糖|餐后血糖)\s*(?:[：:]|是|为)?\s*(\d+(?:\.\d+)?)\s*mmol/i);
        if (glucoseMatch) {
          const val = parseFloat(glucoseMatch[1]);
          if (val > 10.0 || val < 3.9) score = Math.max(score, 0.85);
          else if (val > 7.0) score = Math.max(score, 0.6);
        }

        // 4. 重大神经与意识受损核心诊断/主诉关键词
        const highPriorityKeywords = [
          '昏迷', '嗜睡', '意识障碍', '失语', '偏瘫', '肌力0级', '肌力1级', '肌力2级', '肌力3级',
          '脑出血', '瞳孔反射', '脑疝', '呼吸困难', '窒息', '大出血', '呼吸衰竭'
        ];
        const mediumPriorityKeywords = [
          '骨折', '发热', '体温过高', '心率过快', '心动过速', '胸闷', '气促', '低血压'
        ];

        for (const kw of highPriorityKeywords) {
          if (text.includes(kw)) score = Math.max(score, 0.9);
        }
        for (const kw of mediumPriorityKeywords) {
          if (text.includes(kw)) score = Math.max(score, 0.75);
        }

        fact.attention_score = parseFloat(score.toFixed(2));
      }
    });
    console.log(`[Stage 2] ✓ 完成 (${Date.now() - s2Start}ms)`);

    // ── Stage 3: Assembler & Merge ──
    const s3Start = Date.now();
    console.log('[Stage 3] Merging facts into wiki pages...');

    const formattedFactsForLLM = facts.map((f, idx) => {
      if (f.type === 'observation')
        return `[事实 #${idx}] 类型: observation, 子类型: ${f.subtype}, 内容: "${f.content}", 溯源ID: ${f.log_id || '无'}, 推荐 Attention Score: ${f.attention_score}`;
      else if (f.type === 'user_profile')
        return `[事实 #${idx}] 类型: user_profile, 子类型: ${f.subtype}, 内容: "${f.content}", 溯源ID: ${f.log_id || '无'} → 写入 user_profile.md`;
      else
        return `[事实 #${idx}] 类型: intervention, 子类型: ${f.subtype}, 内容: "${f.content}", 溯源ID: ${f.log_id || '无'}`;
    }).join('\n');

    const stage3Prompt = `你是一个非常专业且细心的医疗健康档案助理。请根据下面给出的【新增结构化事实】，增量更新客户的专属 Markdown Wiki 档案。

⚠️ 格式强制要求（最优先遵守，不得违反）：
- 所有新增的 observation 事实（生理信号、化验结果、功能变化）必须用 \`\`\`observation-block 代码块写入，绝对禁止写成 Markdown 表格行或普通文字。
- 所有新增的 intervention 事实（用药、治疗、管道、护理）必须用 \`\`\`intervention-block 代码块写入，绝对禁止写成普通文字或表格。
- 文件模板中已有的空白表格（如 | — | — |）保留不动，新数据用 Block 写在表格下方。

### 客户基本信息
姓名: ${client.name}
年龄: ${client.age || '未知'}
性别: ${client.gender || '未知'}
已知过敏史: ${client.allergies || '暂无'}

### 客户当前的 Wiki 档案页面内容：
${Object.entries(currentWiki).map(([filename, content]) => `
--- 文件名: ${filename} ---
${content}
`).join('\n')}

### 待合并的新增结构化事实：
${formattedFactsForLLM}

### 更新与结构化 Block 指示（极其重要）：
1. **增量更新**：只需将新事实中体现的内容增量填入或追加修改至对应的文件中。
2. **保护历史信息**：严禁删除已有的重要病史和过敏史。如果过敏史等警示信息在事实中被确认，请在 index.md 的【红线警示】中追加。
3. **观察与干预结构化 Block 语法要求（PRD 核心要求）**：
   - 所有新增加的 **observation**（如生理信号、化验结果、功能变化）必须在其展示的列表中使用以下自定义 Block 格式输出（不要输出为普通的 Markdown 文本）：
     \`\`\`observation-block
     type: observation
     subtype: signal | finding | functional
     content: "具体内容描述"
     evidence_refs:
       - 溯源ID
     attention_score: 注意力分数
     \`\`\`
     其中 \`attention_score\` 必须取我们给出的"推荐 Attention Score"数值。\`evidence_refs\` 是包含"溯源ID"的 YAML 列表。
   - 所有新增加的 **intervention**（如用药、治疗、管道、护理措施）必须在对应的干预措施列表中使用以下自定义 Block 格式输出：
     \`\`\`intervention-block
     type: intervention
     subtype: treatment | pipeline | protection | care
     content: "具体内容描述"
     evidence_refs:
       - 溯源ID
     \`\`\`
4. **AI 安全红线**：严禁包含以下诊断性或恐慌性词语：\`AI确诊\`、\`AI诊断为\`、\`人工智能诊断\`、\`confirmed by AI\`、\`AI confirms\`、\`危及生命\`、\`life-threatening\`、\`AI判断\`。仅客观记录观察，禁止越权诊断！
5. **用户画像信息（user_profile 类型事实）**：如果新增事实中包含 type: "user_profile" 的条目，请将其内容写入 \`user_profile.md\` 对应的章节（基本背景、沟通偏好、必须注意事项、个人与社会属性）。用普通 Markdown 文字写入，不使用 block 格式。如果某个章节已经有内容，将新信息追加到已有内容后面。
6. **输出格式**：请直接输出一个合法的 JSON 对象，只需要包含【被更新或修改的文件】作为 Key（例如只包含 "medical_history.md" 和 "index.md"，未被修改的文件不需要包含在 JSON 中，以节省 Token 并防止截断），Value 是该文件更新后的完整 Markdown 内容。请确保输出是一个严格合法的 JSON 对象，不要包含任何 Markdown 格式包裹（如 \`\`\`json ），不要有任何解释性前缀或后缀。

示例输出格式:
{
  "medical_history.md": "# 既往史与诊疗时间轴...",
  "medication_plan.md": "# 用药方案..."
}`;


    const stage3Response = await getOpenAI().chat.completions.create({
      model: process.env.SYNC_MODEL || 'gemini-3.6-flash',
      messages: [
        { role: 'system', content: 'You are a professional assistant that outputs strict JSON only.' },
        { role: 'user', content: stage3Prompt }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const stage3Content = stage3Response.choices[0]?.message?.content || '{}';
    let updatedWiki;
    try {
      updatedWiki = robustParseJson(stage3Content);
    } catch (e) {
      throw new Error('Stage 3 JSON 解析失败: ' + e.message);
    }

    const fileKeys = ['index.md', 'medical_history.md', 'medication_plan.md', 'communication_timeline.md', 'user_profile.md'];
    if (!fileKeys.some(k => updatedWiki[k] !== undefined))
      throw new Error('大模型未能返回任何有效的 Wiki 页面');

    // 写入更新
    await writeWikiPages(id, updatedWiki);
    await markLogsSynced(unsyncedLogs.map(l => l.id));
    await updateClientMeta(id, { lastSyncAt: new Date().toISOString() });

    const s1Ms = s2Start - s1Start;
    const s2Ms = s3Start - s2Start;
    const s3Ms = Date.now() - s3Start;
    const totalMs = Date.now() - syncStartTime;
    console.log(`[Sync] ✓ 完成 总耗时=${totalMs}ms (S1=${s1Ms}ms S2=${s2Ms}ms S3=${s3Ms}ms)`);

    // 写入 sync history
    await appendSyncHistory(id, {
      timestamp: new Date().toISOString(),
      trigger: req.body?.trigger || 'manual',
      logIds: unsyncedLogs.map(l => l.id),
      logsProcessed: unsyncedLogs.length,
      factsExtracted: facts.length,
      updatedFiles: Object.keys(updatedWiki),
      timingMs: { total: totalMs, stage1: s1Ms, stage2: s2Ms, stage3: s3Ms }
    });

    res.json({
      message: 'Wiki 同步更新成功！',
      wikiUpdated: true,
      updatedFiles: Object.keys(updatedWiki),
      timing_ms: { total: totalMs, stage1: s1Ms, stage2: s2Ms, stage3: s3Ms }
    });
  } catch (err) {
    console.error('[POST /clients/:id/sync] 失败:', err);
    res.status(500).json({ error: '同步失败: ' + err.message });
  }
});

// 10. Sync History
app.get('/api/clients/:id/sync-history', async (req, res) => {
  try {
    const { id } = req.params;
    if (!await findClient(id)) return res.status(404).json({ error: '客户不存在' });
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const history = (await readSyncHistory(id)).slice(0, limit);
    res.json(history);
  } catch (err) {
    console.error('[GET /clients/:id/sync-history]', err);
    res.status(500).json({ error: '获取同步历史失败: ' + err.message });
  }
});

// ─── 多模态图片上传 → OCR → 写入日志 ────────────────────────────────
const MULTIMODAL_SYSTEM = `你是一个专业的医疗单据识别助手。
你的任务是从医疗图片中精确提取结构化的临床信息。

【严格约束 — 必须遵守，不得违反】
1. 只提取图片中明确可见的信息，绝对禁止推测或补全。
2. 如果某字段在图片中不存在或不清晰，必须返回 null，而非猜测值。
3. 禁止使用 "AI确诊"、"AI诊断为"、"确诊"、"诊断为" 等诊断性表达。
4. 禁止提取患者姓名、身份证号、电话号码等个人隐私信息。
5. 所有数值必须附带单位（如 "130/85 mmHg"，不能只写 "130"）。
6. 日期格式统一为 YYYY-MM-DD，无法识别时返回 null。
7. 只输出合法的 JSON，不包含任何 Markdown 代码块或解释性文字。`;

const MULTIMODAL_PROMPT = (docType) => `请识别这张医疗图片（类型：${docType || '未知'}），严格按照以下 JSON 格式输出，不要有任何字段缺失或格式变化：

{
  "document_type": "识别到的文件类型，如：化验单 | 出院小结 | 检查报告 | 处方单 | 诊断证明 | 其他",
  "exam_date": "检查或就诊日期，格式 YYYY-MM-DD，无法识别返回 null",
  "diagnoses": ["疾病名称1", "疾病名称2"],
  "lab_results": [
    { "item": "检测项目名称", "value": "数值+单位", "reference": "参考范围或null", "flag": "正常|偏高|偏低|null" }
  ],
  "vital_signs": [
    { "item": "指标名称如血压/心率/体温", "value": "数值+单位", "flag": "正常|偏高|偏低|null" }
  ],
  "medications": [
    { "name": "药品名称", "dose": "剂量", "frequency": "频次" }
  ],
  "clinical_summary": "用一句客观描述图片核心内容，不含诊断判断，最多100字。若图片不清晰则写「图片内容无法识别」",
  "is_duplicate": false,
  "cannot_recognize": false
}

注意：
- lab_results 和 vital_signs 中，每一项必须有实际数值才能列入，不能列入"未见异常"等无数值的描述项。
- diagnoses 只填写图片中明确写明的诊断，不要根据化验值推断疾病。
- 如果图片根本无法识别（模糊、非医疗文件），将 cannot_recognize 设为 true，其余字段设为 null 或 []。`;


app.post('/api/clients/:id/upload-image', async (req, res) => {
  try {
    const { id } = req.params;
    const client = await findClient(id);
    if (!client) return res.status(404).json({ error: '客户不存在' });

    const { image_base64, image_url, document_type } = req.body;
    if (!image_base64 && !image_url)
      return res.status(400).json({ error: '必须提供 image_base64 或 image_url' });

    const imageContent = image_base64
      ? { type: 'image_url', image_url: { url: image_base64 } }
      : { type: 'image_url', image_url: { url: image_url } };

    const response = await getOpenAI().chat.completions.create({
      model: process.env.VISION_MODEL || process.env.SYNC_MODEL || 'gemini-3.6-flash',
      messages: [
        { role: 'system', content: MULTIMODAL_SYSTEM },
        { role: 'user', content: [{ type: 'text', text: MULTIMODAL_PROMPT(document_type) }, imageContent] }
      ],
      temperature: 0.05,
      max_tokens: 1500,
    });

    const rawContent = response.choices[0]?.message?.content || '{}';
    let ocrResult;
    try { ocrResult = robustParseJson(rawContent); }
    catch (e) { return res.status(500).json({ error: 'OCR 结果解析失败: ' + e.message }); }

    if (ocrResult.cannot_recognize)
      return res.status(422).json({ error: '图片无法识别（模糊或非医疗文件）', ocrResult });

    const logLines = [`【医疗单据识别】文件类型：${ocrResult.document_type || '未知'}`];
    if (ocrResult.exam_date) logLines.push(`检查日期：${ocrResult.exam_date}`);
    if (ocrResult.diagnoses?.length) logLines.push(`诊断记录：${ocrResult.diagnoses.join('、')}`);
    if (ocrResult.vital_signs?.length) {
      logLines.push('生理指标：');
      ocrResult.vital_signs.forEach(v => logLines.push(`  - ${v.item}: ${v.value}${v.flag && v.flag !== '正常' ? `（${v.flag}）` : ''}`));
    }
    if (ocrResult.lab_results?.length) {
      logLines.push('化验结果：');
      ocrResult.lab_results.forEach(r => logLines.push(`  - ${r.item}: ${r.value}${r.reference ? `（参考：${r.reference}）` : ''}${r.flag && r.flag !== '正常' ? ` [${r.flag}]` : ''}`));
    }
    if (ocrResult.medications?.length) {
      logLines.push('用药信息：');
      ocrResult.medications.forEach(m => logLines.push(`  - ${m.name} ${m.dose} ${m.frequency}`));
    }
    if (ocrResult.clinical_summary) logLines.push(`临床摘要：${ocrResult.clinical_summary}`);

    const logContent = logLines.join('\n');
    const logTitle = `${ocrResult.document_type || '医疗单据'}（${ocrResult.exam_date || '日期未知'}）`;
    const logId = `log_${Date.now()}`;

    await appendLog(id, { id: logId, type: 'ocr', title: logTitle, content: logContent, created_at: Date.now() });
    console.log(`[upload-image] ✓ 客户 ${id} OCR 日志写入成功 (${logId})`);

    res.status(201).json({ message: '图片识别成功，已写入日志', logId, ocrResult, logContent });
  } catch (err) {
    console.error('[upload-image] 错误:', err);
    res.status(500).json({ error: '图片识别失败: ' + err.message });
  }
});

// 通用划词 AI 解读接口
app.post('/api/chat', async (req, res) => {
  const { action, text, context } = req.body;
  if (!text) return res.status(400).json({ error: '缺少待解析的文本' });

  let prompt = '';
  if (action === 'explain') {
    prompt = `你是一个专业的健康管理顾问，请针对以下医学术语或诊断指标进行简明易懂的解释，适合普通人阅读，并在150字以内完成：\n\n"${text}"`;
  } else if (action === 'contraindication') {
    prompt = `你是一个药理学专家，请分析以下药物在临床使用中的主要副作用、配伍禁忌和用药注意事项，并在150字以内完成：\n\n"${text}"`;
  } else {
    prompt = `针对文本 "${text}" 进行健康或用药咨询：请用简单易懂的语言解答，并在150字以内完成。`;
  }
  if (context) prompt += `\n\n上下文背景参考：\n${context}`;

  try {
    const response = await getOpenAI().chat.completions.create({
      model: process.env.SYNC_MODEL || 'gemini-3.6-flash',
      messages: [
        { role: 'system', content: '你是一个贴心的健康管理助理，用简明扼要的中文进行回复。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3
    });
    res.json({ reply: (response.choices[0]?.message?.content || '无回答').trim() });
  } catch (err) {
    console.error('[api/chat] 错误:', err);
    res.status(500).json({ error: 'AI 解析失败: ' + err.message });
  }
});

// SPA fallback
if (fs.existsSync(DIST_DIR)) {
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// ── 启动时验证 DB 连接 ──
pool.query('SELECT 1').then(() => {
  console.log('[DB] ✓ Supabase 连接成功（llmwiki schema）');
}).catch(err => {
  console.error('[DB] ✗ 数据库连接失败:', err.message);
});

app.listen(PORT, () => {
  console.log(`LLM Wiki 后端服务运行在端口 ${PORT}`);
});
