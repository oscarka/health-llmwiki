const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ──────────────────── 前端静态文件 ────────────────────
// Vite build 产物在 dist/，API 路由优先（/api/*），其余交给前端路由
const DIST_DIR = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
}

// ──────────────────── 数据存储路径配置 ────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const WIKI_DIR = path.join(DATA_DIR, 'wiki');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const SYNC_HISTORY_DIR = path.join(DATA_DIR, 'sync_history');

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(WIKI_DIR)) fs.mkdirSync(WIKI_DIR);
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);
if (!fs.existsSync(SYNC_HISTORY_DIR)) fs.mkdirSync(SYNC_HISTORY_DIR);
if (!fs.existsSync(CLIENTS_FILE)) fs.writeFileSync(CLIENTS_FILE, JSON.stringify([], null, 2));

// ──────────────────── 辅助工具函数 ────────────────────
const readClients = () => {
  try {
    const data = fs.readFileSync(CLIENTS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
};

const writeClients = (clients) => {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
};

const readLogs = (clientId) => {
  const file = path.join(LOGS_DIR, `${clientId}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return [];
  }
};

const writeLogs = (clientId, logs) => {
  const file = path.join(LOGS_DIR, `${clientId}.json`);
  fs.writeFileSync(file, JSON.stringify(logs, null, 2));
};

const readWikiPages = (clientId) => {
  const clientWikiDir = path.join(WIKI_DIR, clientId);
  if (!fs.existsSync(clientWikiDir)) return {};
  
  const pages = {};
  const files = fs.readdirSync(clientWikiDir);
  files.forEach(file => {
    if (file.endsWith('.md')) {
      const content = fs.readFileSync(path.join(clientWikiDir, file), 'utf8');
      pages[file] = content;
    }
  });
  return pages;
};

const writeWikiPages = (clientId, pages) => {
  const clientWikiDir = path.join(WIKI_DIR, clientId);
  if (!fs.existsSync(clientWikiDir)) fs.mkdirSync(clientWikiDir, { recursive: true });
  
  Object.keys(pages).forEach(filename => {
    if (filename.endsWith('.md')) {
      fs.writeFileSync(path.join(clientWikiDir, filename), pages[filename], 'utf8');
    }
  });
};

// ── Sync History（Wiki 变更日志）────────────────────────────
const readSyncHistory = (clientId) => {
  const file = path.join(SYNC_HISTORY_DIR, `${clientId}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
};

const appendSyncHistory = (clientId, entry) => {
  const file = path.join(SYNC_HISTORY_DIR, `${clientId}.json`);
  const history = readSyncHistory(clientId);
  history.unshift(entry);               // 最新的放最前
  if (history.length > 100) history.length = 100; // 最多保留 100 条
  fs.writeFileSync(file, JSON.stringify(history, null, 2));
};

const deleteClientData = (clientId) => {
  // 删除 logs
  const logFile = path.join(LOGS_DIR, `${clientId}.json`);
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  
  // 删除 wiki 文件夹
  const clientWikiDir = path.join(WIKI_DIR, clientId);
  if (fs.existsSync(clientWikiDir)) {
    fs.rmSync(clientWikiDir, { recursive: true, force: true });
  }

  // 删除 sync history
  const syncFile = path.join(SYNC_HISTORY_DIR, `${clientId}.json`);
  if (fs.existsSync(syncFile)) fs.unlinkSync(syncFile);
};


// 健壮的 JSON 解析与自动修复函数，防止 LLM 输出截断或转义错误导致 JSON.parse 崩溃
const robustParseJson = (str) => {
  let cleaned = str.trim();
  if (cleaned.startsWith('```')) {
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) cleaned = match[1].trim();
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('[robustParseJson] 初始 JSON 解析失败，尝试进行括号及字符串闭合自动修复...', e.message);
  }

  let inString = false;
  let escape = false;
  let stack = [];
  let repaired = '';
  
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    repaired += char;
    
    if (escape) {
      escape = false;
      continue;
    }
    
    if (char === '\\') {
      escape = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}') {
        if (stack[stack.length - 1] === '{') stack.pop();
      } else if (char === ']') {
        if (stack[stack.length - 1] === '[') stack.pop();
      }
    }
  }
  
  if (inString) {
    repaired += '"';
  }
  
  while (stack.length > 0) {
    const open = stack.pop();
    if (open === '{') repaired += '}';
    if (open === '[') repaired += ']';
  }
  
  try {
    return JSON.parse(repaired);
  } catch (e2) {
    try {
      const sanitized = repaired.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, p1) => {
        return '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
      });
      return JSON.parse(sanitized);
    } catch (e3) {
      throw new Error(`JSON 解析及自动修复失败: ${e.message}. 自动修复后错误: ${e3.message}. 原始字符串长度: ${str.length}`);
    }
  }
};

// ──────────────────── 默认 Wiki 模板（PRD 8分区认知骨架）────────────────────
const createDefaultWiki = (client) => {
  const ageStr = client.age ? `${client.age}岁` : '未知年龄';
  const genderStr = client.gender || '未知性别';
  return {
    'index.md': `# 客户健康首页：${client.name}
> [!IMPORTANT]
> **红线警示（过敏史/慢性病）**：${client.allergies || '无登记'}

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

// 估算中文文本的大约 token 数（1 中文字符 ≈ 0.6 token，英文字母/数字 ≈ 0.25 token）
const estimateTokens = (text) => {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 0.6 + otherChars * 0.25);
};

// 构建 Block 3 健康档案摘要：默认只用 index.md，附上按需取的工具提示
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

// ── Prefetch：基于关键词匹配的轻量级 Section 检索 ──

// 将 Wiki 页面切分为 section 片段（按 ## 标题分段）
function splitWikiSections(wikiPages) {
  const sections = [];
  const skipPages = ['user_profile.md']; // 用户画像单独注入，不参与 prefetch
  for (const [filename, content] of Object.entries(wikiPages)) {
    if (skipPages.includes(filename) || !content) continue;
    // 按 ## 标题切分
    const parts = content.split(/(?=^## )/m);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.length < 20) continue; // 跳过空段或太短的段
      // 提取标题
      const titleMatch = trimmed.match(/^##?\s+(.+)/);
      const title = titleMatch ? titleMatch[1].trim() : '(无标题)';
      sections.push({
        filename,
        title,
        content: trimmed,
        charCount: trimmed.length,
      });
    }
  }
  return sections;
}

// BM25-lite 评分：对 query 做分词，然后在每个 section 里统计命中数和密度
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
      // TF 分：命中次数 / 文段长度（归一化）
      score += matches.length / Math.sqrt(section.charCount);
    }
  }
  // 标题命中额外加权（标题里出现关键词更可能是相关段）
  const titleLower = section.title.toLowerCase();
  for (const term of queryTerms) {
    if (term && titleLower.includes(term)) score += 2.0;
  }
  return { ...section, score, matchCount };
}

// 对中文+英文混合 query 做简易分词：中文按字/2-gram，英文按空格
function tokenizeQuery(query) {
  const terms = [];
  // 英文单词
  const englishWords = query.match(/[a-zA-Z0-9]+/g) || [];
  terms.push(...englishWords.map(w => w.toLowerCase()));
  // 中文：提取所有中文连续片段，按 2-gram 切分
  const chineseSegments = query.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of chineseSegments) {
    if (seg.length <= 2) {
      terms.push(seg);
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        terms.push(seg.substring(i, i + 2));
      }
      // 也加入整段（精确匹配权重高）
      if (seg.length <= 6) terms.push(seg);
    }
  }
  return [...new Set(terms)]; // 去重
}

// Prefetch 主函数：返回最相关的 top-N section 片段
function prefetchRelevantSections(wikiPages, query, topN = 6) {
  const sections = splitWikiSections(wikiPages);
  if (sections.length === 0) return [];
  const queryTerms = tokenizeQuery(query);
  if (queryTerms.length === 0) return [];

  const scored = sections
    .map(s => scoreSection(s, queryTerms))
    .filter(s => s.matchCount > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return scored;
}

// 构建 prefetch 模式下的健康档案注入内容
function buildPrefetchContext(wikiPages, query) {
  const sections = prefetchRelevantSections(wikiPages, query, 6);
  if (sections.length === 0) {
    // 没有匹配，降级回全量 index.md
    return buildHealthContext(wikiPages);
  }

  const header = `📌 **以下是与当前问题最相关的健康档案片段**（共 ${sections.length} 段，按相关性排序）：\n`;
  const body = sections.map((s, i) =>
    `### [${i + 1}] ${s.filename} › ${s.title}\n${s.content}`
  ).join('\n\n---\n\n');

  const toolHint = `\n---\n📋 **如需更多详情可调用工具**：\n- \`get_medical_history\` → 完整历史病史\n- \`get_medication_plan\` → 完整用药方案`;

  return header + body + toolHint;
}



// ──────────────────── REST APIs ────────────────────

// 1. 获取所有客户列表
app.get('/api/clients', (req, res) => {
  const clients = readClients();
  res.json(clients);
});

// 2. 创建客户
app.post('/api/clients', (req, res) => {
  const { id: externalId, name, age, gender, phone, allergies } = req.body;
  if (!name) return res.status(400).json({ error: '姓名是必填项' });

  const clients = readClients();

  // 支持外部指定 id（Agent 自动建档场景），如已存在则直接返回
  const clientId = externalId || `client_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const existing = clients.find(c => c.id === clientId);
  if (existing) {
    return res.status(200).json(existing); // 幂等：已存在就返回，不报错
  }

  const newClient = {
    id: clientId,
    name,
    age: age ? parseInt(age) : null,
    gender,
    phone,
    allergies,
    createdAt: new Date().toISOString(),
    lastSyncAt: null
  };

  clients.push(newClient);
  writeClients(clients);

  // 初始化默认 Wiki
  const defaultWiki = createDefaultWiki(newClient);
  writeWikiPages(newClient.id, defaultWiki);

  console.log(`[CreateClient] 新建客户 id=${clientId} name=${name} external=${!!externalId}`);
  res.status(201).json(newClient);
});

// 3. 更新客户基本信息
app.put('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const { name, age, gender, phone, allergies } = req.body;

  const clients = readClients();
  const index = clients.findIndex(c => c.id === id);
  if (index === -1) return res.status(404).json({ error: '客户不存在' });

  clients[index] = {
    ...clients[index],
    name: name || clients[index].name,
    age: age !== undefined ? parseInt(age) : clients[index].age,
    gender: gender !== undefined ? gender : clients[index].gender,
    phone: phone !== undefined ? phone : clients[index].phone,
    allergies: allergies !== undefined ? allergies : clients[index].allergies
  };

  writeClients(clients);
  res.json(clients[index]);
});

// 4. 删除客户
app.delete('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  let clients = readClients();
  const index = clients.findIndex(c => c.id === id);
  if (index === -1) return res.status(404).json({ error: '客户不存在' });

  clients.splice(index, 1);
  writeClients(clients);
  deleteClientData(id);

  res.json({ success: true, message: '客户及相关 Wiki 档案已成功删除' });
});

// 5. 获取客户 Wiki 的所有页面
app.get('/api/clients/:id/wiki', (req, res) => {
  const { id } = req.params;
  const clients = readClients();
  if (!clients.some(c => c.id === id)) return res.status(404).json({ error: '客户不存在' });

  const wikiPages = readWikiPages(id);
  res.json(wikiPages);
});

// 5b. Agent 专用：获取格式化好的 System Prompt 注入内容
// 返回 user_profile（全量）+ health_wiki + token 估算
// 支持 ?query=xxx 启用 prefetch 模式（按关键词检索最相关的 wiki 片段）
app.get('/api/clients/:id/context-inject', (req, res) => {
  const { id } = req.params;
  const query = req.query.query || ''; // prefetch 关键词
  const clients = readClients();
  const client = clients.find(c => c.id === id);
  if (!client) return res.status(404).json({ error: '客户不存在' });

  const wikiPages = readWikiPages(id);
  const userProfile = wikiPages['user_profile.md'] || '';

  // ── 新用户（从未 sync 过）：不注入空模板，避免误导 ──
  if (!client.lastSyncAt) {
    const brief = client.allergies ? `⚠️ 过敏史：${client.allergies}` : '';
    return res.json({
      user_profile: userProfile,
      health_wiki: brief,  // 只返回关键安全信息（过敏），不返回占位模板
      mode: 'new_user',
      token_estimate: {
        user_profile: estimateTokens(userProfile),
        health_wiki: estimateTokens(brief),
        total: estimateTokens(userProfile) + estimateTokens(brief)
      }
    });
  }

  // 有 query → prefetch 模式（检索相关片段）；无 query → 全量 index.md
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
});


// 6. 保存/修改单个 Wiki 页面（手动编辑）
app.put('/api/clients/:id/wiki/:pageName', (req, res) => {
  const { id, pageName } = req.params;
  const { content } = req.body;

  const clients = readClients();
  if (!clients.some(c => c.id === id)) return res.status(404).json({ error: '客户不存在' });
  if (!pageName.endsWith('.md')) return res.status(400).json({ error: '仅支持保存 .md 格式的 Wiki 页面' });
  if (pageName.includes('..') || pageName.includes('/') || pageName.includes('\\')) return res.status(400).json({ error: '页面名称不合法' });

  const pages = { [pageName]: content };
  writeWikiPages(id, pages);
  res.json({ success: true, message: `页面 ${pageName} 保存成功` });
});

// 7. 获取客户的原始日志
app.get('/api/clients/:id/logs', (req, res) => {
  const { id } = req.params;
  const clients = readClients();
  if (!clients.some(c => c.id === id)) return res.status(404).json({ error: '客户不存在' });

  const logs = readLogs(id);
  res.json(logs);
});

// 8. 录入一条新的原始沟通日志
app.post('/api/clients/:id/logs', (req, res) => {
  const { id } = req.params;
  const { type, content, title } = req.body; // type: phone | video | wechat | ocr
  if (!type || !content) return res.status(400).json({ error: '类型和内容为必填项' });

  // Strict enum validation for log type
  const VALID_LOG_TYPES = ['phone', 'video', 'wechat', 'ocr'];
  if (!VALID_LOG_TYPES.includes(type)) {
    return res.status(400).json({ error: `日志类型无效，必须是以下之一: ${VALID_LOG_TYPES.join(', ')}` });
  }

  const clients = readClients();
  if (!clients.some(c => c.id === id)) return res.status(404).json({ error: '客户不存在' });

  const logs = readLogs(id);
  const randomSuffix = Math.random().toString(36).substring(2, 6);
  const newLog = {
    id: `log_${Date.now()}_${randomSuffix}`,
    type,
    title: title || `${type === 'phone' ? '电话问诊' : type === 'video' ? '视频问诊' : type === 'wechat' ? '企微记录' : '单证OCR'} (${new Date().toLocaleDateString()})`,
    content,
    timestamp: new Date().toISOString(),
    synced: false
  };

  logs.push(newLog);
  writeLogs(id, logs);
  res.status(201).json(newLog);
});

// 8b. 批量录入多条沟通日志（Agent 在触发 sync 时使用，减少 HTTP 请求次数）
app.post('/api/clients/:id/logs/batch', (req, res) => {
  const { id } = req.params;
  const { logs: inputLogs } = req.body;

  if (!Array.isArray(inputLogs) || inputLogs.length === 0) {
    return res.status(400).json({ error: 'logs 字段必须是非空数组' });
  }

  const clients = readClients();
  if (!clients.some(c => c.id === id)) return res.status(404).json({ error: '客户不存在' });

  const VALID_LOG_TYPES = ['phone', 'video', 'wechat', 'ocr'];
  const existingLogs = readLogs(id);
  const insertedIds = [];
  const errors = [];

  for (let i = 0; i < inputLogs.length; i++) {
    const { type, content, title } = inputLogs[i];
    if (!type || !content) { errors.push(`第${i+1}条缺少 type 或 content`); continue; }
    if (!VALID_LOG_TYPES.includes(type)) { errors.push(`第${i+1}条 type 无效: ${type}`); continue; }

    const randomSuffix = Math.random().toString(36).substring(2, 6);
    const newLog = {
      id: `log_${Date.now()}_${randomSuffix}`,
      type,
      title: title || `批量录入-${type} (${new Date().toLocaleDateString()})`,
      content,
      timestamp: new Date().toISOString(),
      synced: false
    };
    existingLogs.push(newLog);
    insertedIds.push(newLog.id);
  }

  writeLogs(id, existingLogs);
  res.status(201).json({
    success: true,
    inserted: insertedIds.length,
    ids: insertedIds,
    errors: errors.length > 0 ? errors : undefined
  });
});

// ──────────────────── LLM 增量汇总逻辑（Gemini Flash via OpenAI 兼容）────────────────────

let _openaiClient = null;
function getOpenAI() {
  if (!_openaiClient) {
    // 优先用 Gemini，降级到 Doubao
    const apiKey = process.env.GEMINI_API_KEY || process.env.ARK_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY 或 ARK_API_KEY 环境变量未设置，无法调用 LLM');
    }
    const baseURL = process.env.GEMINI_API_KEY
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
      : (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3');
    console.log(`[LLM] 使用 ${process.env.GEMINI_API_KEY ? 'Gemini' : 'Doubao'} baseURL=${baseURL}`);
    _openaiClient = new OpenAI({
      apiKey,
      baseURL,
    });
  }
  return _openaiClient;
}

app.post('/api/clients/:id/sync', async (req, res) => {
  const { id } = req.params;
  const clients = readClients();
  const clientIndex = clients.findIndex(c => c.id === id);
  if (clientIndex === -1) return res.status(404).json({ error: '客户不存在' });

  const client = clients[clientIndex];
  const logs = readLogs(id);
  const unsyncedLogs = logs.filter(l => !l.synced);

  if (unsyncedLogs.length === 0) {
    return res.json({ message: '暂无未同步的沟通记录', wikiUpdated: false });
  }

  const currentWiki = readWikiPages(id);

  try {
    const syncStartTime = Date.now();
    // -------------------------------------------------------------
    // Stage 1: Fact Parse & Categorization
    // -------------------------------------------------------------
    const s1Start = Date.now();
    console.log(`[Stage 1] Extracting clinical facts from ${unsyncedLogs.length} logs for client ${id}...`);
    const stage1Prompt = `你是一个非常专业且细心的医疗事实提取助手。请从下面新增的沟通记录中提取所有的临床观察、医疗干预事实，以及用户画像信息（例如：新增诊断、主诉症状、生理指标数值、化验/CT检查结果、用药变更、留置管道、护理措施、沟通偏好、个人背景等）。
严禁凭空编造事实或添加沟通记录中未提及的内容。对于每一条事实，必须明确匹配其来自哪一条沟通记录 of ID。

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
      response_format: { type: "json_object" }
    });

    const stage1Content = stage1Response.choices[0]?.message?.content || '{}';
    let parsedFactsObj;
    try {
      parsedFactsObj = robustParseJson(stage1Content);
    } catch (e) {
      console.error('Failed to parse Stage 1 JSON:', stage1Content);
      throw new Error('临床事实提取失败：' + e.message);
    }

    const facts = parsedFactsObj.facts || [];
    console.log(`[Stage 1] ✓ 完成 (${Date.now() - s1Start}ms, ${facts.length} 条事实)`);

    // -------------------------------------------------------------
    // Stage 2: Heuristic-based Attention Scoring
    // -------------------------------------------------------------
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
          if (text.includes(kw)) {
            score = Math.max(score, 0.9);
          }
        }
        for (const kw of mediumPriorityKeywords) {
          if (text.includes(kw)) {
            score = Math.max(score, 0.75);
          }
        }

        fact.attention_score = parseFloat(score.toFixed(2));
      }
    });
    console.log(`[Stage 2] ✓ 完成 (${Date.now() - s2Start}ms)`);

    // -------------------------------------------------------------
    // Stage 3: Assembler & Merge into Wiki pages
    // -------------------------------------------------------------
    const s3Start = Date.now();
    console.log('[Stage 3] Merging clinical facts and generating formatted markdown blocks...');
    
    // 格式化传入 Stage 3 的事实列表，确保大模型获得清晰的数据关联
    const formattedFactsForLLM = facts.map((f, idx) => {
      if (f.type === 'observation') {
        return `[事实 #${idx}] 类型: observation, 子类型: ${f.subtype}, 内容: "${f.content}", 溯源ID: ${f.log_id || '无'}, 推荐 Attention Score: ${f.attention_score}`;
      } else if (f.type === 'user_profile') {
        return `[事实 #${idx}] 类型: user_profile, 子类型: ${f.subtype}, 内容: "${f.content}", 溯源ID: ${f.log_id || '无'} → 写入 user_profile.md`;
      } else {
        return `[事实 #${idx}] 类型: intervention, 子类型: ${f.subtype}, 内容: "${f.content}", 溯源ID: ${f.log_id || '无'}`;
      }
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
     其中 \`attention_score\` 必须取我们给出的“推荐 Attention Score”数值。\`evidence_refs\` 是包含“溯源ID”的 YAML 列表。
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
        { role: 'system', content: 'You are a professional assistant that outputs strict JSON only. Do not include markdown codeblocks or extra text.' },
        { role: 'user', content: stage3Prompt }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const stage3Content = stage3Response.choices[0]?.message?.content || '{}';
    let updatedWiki;
    try {
      updatedWiki = robustParseJson(stage3Content);
    } catch (e) {
      console.error('Failed to parse Stage 3 JSON:', stage3Content);
      throw new Error('大模型返回的 Wiki JSON 解析失败: ' + e.message);
    }

    // 验证返回的 Wiki 页面是否有效
    const fileKeys = ['index.md', 'medical_history.md', 'medication_plan.md', 'communication_timeline.md', 'user_profile.md'];
    const validUpdate = fileKeys.some(key => updatedWiki[key] !== undefined);
    if (!validUpdate) {
      throw new Error('大模型未能返回任何有效的 Wiki 页面 JSON 数据');
    }

    // 写入更新后的 Wiki 页面（若报错则不进行物理写入，保障事务隔离）
    writeWikiPages(id, updatedWiki);

    // 将这些 logs 标记为已同步
    logs.forEach(l => {
      if (!l.synced) l.synced = true;
    });
    writeLogs(id, logs);

    // 更新客户最后同步时间
    client.lastSyncAt = new Date().toISOString();
    writeClients(clients);

    const s1Ms = s2Start - s1Start;
    const s2Ms = s3Start - s2Start;
    const s3Ms = Date.now() - s3Start;
    const totalMs = Date.now() - syncStartTime;
    console.log(`[Stage 3] ✓ 完成 (${s3Ms}ms)`);
    console.log(`[Sync] ✓ 全流程完成 总耗时=${totalMs}ms (S1=${s1Ms}ms S2=${s2Ms}ms S3=${s3Ms}ms)`);

    // ── 写入 Wiki 变更日志（sync history）──
    const syncEntry = {
      timestamp: new Date().toISOString(),
      trigger: req.body?.trigger || 'manual',
      logsProcessed: unsyncedLogs.length,
      factsExtracted: facts.length,
      updatedFiles: Object.keys(updatedWiki),
      timingMs: { total: totalMs, stage1: s1Ms, stage2: s2Ms, stage3: s3Ms }
    };
    appendSyncHistory(id, syncEntry);

    res.json({
      message: 'Wiki 同步更新成功！',
      wikiUpdated: true,
      updatedFiles: Object.keys(updatedWiki),
      timing_ms: { total: totalMs, stage1: s1Ms, stage2: s2Ms, stage3: s3Ms }
    });

  } catch (err) {
    console.error('多阶段同步失败:', err);
    res.status(500).json({ error: '同步过程中处理多阶段 AI Pipeline 失败: ' + err.message });
  }
});

// ─── Wiki 变更日志（Sync History）────────────────────────────────────
// GET /api/clients/:id/sync-history
// 返回最近 N 条 sync 记录，按时间倒序排列
app.get('/api/clients/:id/sync-history', (req, res) => {
  const { id } = req.params;
  const clients = readClients();
  if (!clients.find(c => c.id === id)) return res.status(404).json({ error: '客户不存在' });

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const history = readSyncHistory(id).slice(0, limit);
  res.json(history);
});

// ─── 多模态图片上传 → OCR → 写入日志 ────────────────────────────────
// POST /api/clients/:id/upload-image
// body: { image_base64: "data:image/jpeg;base64,...", image_url: "https://...", document_type: "化验单" }
// 调用多模态模型严格提取医疗信息，写入 type=ocr 的日志
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
  const { id } = req.params;
  const clients = readClients();
  const clientIndex = clients.findIndex(c => c.id === id);
  if (clientIndex === -1) return res.status(404).json({ error: '客户不存在' });

  const { image_base64, image_url, document_type } = req.body;
  if (!image_base64 && !image_url) {
    return res.status(400).json({ error: '必须提供 image_base64 或 image_url' });
  }

  try {
    // 构建 messages（支持 base64 和 URL 两种方式）
    const imageContent = image_base64
      ? { type: 'image_url', image_url: { url: image_base64 } }  // data:image/jpeg;base64,...
      : { type: 'image_url', image_url: { url: image_url } };

    const response = await getOpenAI().chat.completions.create({
      model: process.env.VISION_MODEL || process.env.SYNC_MODEL || 'gemini-3.6-flash',
      messages: [
        { role: 'system', content: MULTIMODAL_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: MULTIMODAL_PROMPT(document_type) },
            imageContent
          ]
        }
      ],
      temperature: 0.05,   // 极低温度，减少随机性
      max_tokens: 1500,
    });

    const rawContent = response.choices[0]?.message?.content || '{}';
    let ocrResult;
    try {
      ocrResult = robustParseJson(rawContent);
    } catch (e) {
      console.error('[upload-image] OCR 解析失败:', rawContent);
      return res.status(500).json({ error: 'OCR 结果解析失败: ' + e.message });
    }

    // 如果图片无法识别
    if (ocrResult.cannot_recognize) {
      return res.status(422).json({ error: '图片无法识别（模糊或非医疗文件）', ocrResult });
    }

    // 将 OCR 结构化结果序列化为可读的日志内容
    const logLines = [];
    logLines.push(`【医疗单据识别】文件类型：${ocrResult.document_type || '未知'}`);
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

    // 写入日志
    const logId = `log_${Date.now()}`;
    const logs = readLogs(id);
    logs.push({ id: logId, type: 'ocr', title: logTitle, content: logContent, timestamp: new Date().toISOString(), synced: false });
    writeLogs(id, logs);

    console.log(`[upload-image] ✓ 客户 ${id} OCR 日志写入成功 (${logId})`);
    res.status(201).json({
      message: '图片识别成功，已写入日志',
      logId,
      ocrResult,
      logContent
    });

  } catch (err) {
    console.error('[upload-image] 错误:', err);
    res.status(500).json({ error: '图片识别失败: ' + err.message });
  }
});

// 3. 通用划词 AI 解读接口

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

  if (context) {
    prompt += `\n\n上下文背景参考：\n${context}`;
  }

  try {
    const response = await getOpenAI().chat.completions.create({
      model: process.env.SYNC_MODEL || 'gemini-3.6-flash',
      messages: [
        { role: 'system', content: '你是一个贴心的健康管理助理，用简明扼要的中文进行回复。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3
    });
    const reply = response.choices[0]?.message?.content || '无回答';
    res.json({ reply: reply.trim() });
  } catch (err) {
    console.error('划词 AI 解析失败:', err);
    res.status(500).json({ error: 'AI 解析失败: ' + err.message });
  }
});
// SPA fallback：所有非 /api/* 路由返回前端 index.html
// Express 5 要求通配符必须命名，用 /{*path} 而非 *
if (fs.existsSync(DIST_DIR)) {
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// 启动服务器
app.listen(PORT, () => {
  console.log(`LLM Wiki 后端服务运行在端口 ${PORT}`);
});
