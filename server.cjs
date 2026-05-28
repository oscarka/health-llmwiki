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

// ──────────────────── 数据存储路径配置 ────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const WIKI_DIR = path.join(DATA_DIR, 'wiki');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(WIKI_DIR)) fs.mkdirSync(WIKI_DIR);
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);
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

const deleteClientData = (clientId) => {
  // 删除 logs
  const logFile = path.join(LOGS_DIR, `${clientId}.json`);
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  
  // 删除 wiki 文件夹
  const clientWikiDir = path.join(WIKI_DIR, clientId);
  if (fs.existsSync(clientWikiDir)) {
    fs.rmSync(clientWikiDir, { recursive: true, force: true });
  }
};

// ──────────────────── 默认 Wiki 模板 ────────────────────
const createDefaultWiki = (client) => {
  const ageStr = client.age ? `${client.age}岁` : '未知年龄';
  const genderStr = client.gender || '未知性别';
  return {
    'index.md': `# 客户健康首页：${client.name}
> [!IMPORTANT]
> **红线警示（过敏史/慢性病）**：${client.allergies || '无登记'}

## 1. 客户基本画像
* **基本信息**：${genderStr}，${ageStr}，电话：${client.phone || '未录入'}。
* **主要诊断**：待大模型汇总录入。
* **近期主要健康主诉**：暂无记录。

## 2. 快捷导航
* [既往史与诊疗时间轴](medical_history.md)
* [用药方案与生活医嘱](medication_plan.md)
* [随访互动摘要](communication_timeline.md)
`,
    'medical_history.md': `# 既往史与诊疗时间轴

## 1. 既往病史
* **慢性病**：暂无登记。
* **手术/外伤史**：暂无登记。

## 2. 诊疗轨迹时间轴
*(以下内容将随医生问诊及单证 OCR 录入由大模型自动追加并精简)*
暂无记录。
`,
    'medication_plan.md': `# 用药方案与生活医嘱

## 1. 当前用药方案
暂无记录。

## 2. 生活指导及预防建议
暂无记录。
`,
    'communication_timeline.md': `# 随访互动与沟通摘要

## 1. 互动摘要时间线
*(这里记录企微、电话、视频沟通的核心简报，帮助快速了解最近联系动态)*
暂无记录。
`
  };
};

// ──────────────────── REST APIs ────────────────────

// 1. 获取所有客户列表
app.get('/api/clients', (req, res) => {
  const clients = readClients();
  res.json(clients);
});

// 2. 创建客户
app.post('/api/clients', (req, res) => {
  const { name, age, gender, phone, allergies } = req.body;
  if (!name) return res.status(400).json({ error: '姓名是必填项' });

  const clients = readClients();
  const newClient = {
    id: `client_${Date.now()}`,
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

// 6. 保存/修改单个 Wiki 页面（手动编辑）
app.put('/api/clients/:id/wiki/:pageName', (req, res) => {
  const { id, pageName } = req.params;
  const { content } = req.body;

  const clients = readClients();
  if (!clients.some(c => c.id === id)) return res.status(404).json({ error: '客户不存在' });
  if (!pageName.endsWith('.md')) return res.status(400).json({ error: '仅支持保存 .md 格式的 Wiki 页面' });

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

  const clients = readClients();
  if (!clients.some(c => c.id === id)) return res.status(404).json({ error: '客户不存在' });

  const logs = readLogs(id);
  const newLog = {
    id: `log_${Date.now()}`,
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

// ──────────────────── 豆包大模型增量汇总逻辑 ────────────────────

const openai = new OpenAI({
  apiKey: process.env.ARK_API_KEY,
  baseURL: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
});

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

  // 构造大模型 Prompt
  const prompt = `你是一个非常专业且细心的医疗健康档案助理，你的职责是根据新增的沟通记录，增量且克制地更新客户的专属 Markdown Wiki 档案。

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

### 待合并的新增沟通记录 (ASR/企微/OCR)：
${unsyncedLogs.map(log => `
[类型: ${log.type}] [标题: ${log.title}] [时间: ${log.timestamp}]
内容: 
${log.content}
`).join('\n\n')}

### 更新指示与规则（极其重要）：
1. **增量更新**：只需将新沟通记录中体现的【新增诊断、近期主诉、用药变更、生活建议、企微沟通核心事件】增量填入或追加修改至对应的文件中。
2. **保护历史信息**：严禁删除已有的重要病史和过敏史。如果过敏史等警示信息在沟通中被确认，请在 index.md 的【红线警示】中追加。
3. **输出格式**：请直接输出一个合法的 JSON 对象，Key 是文件名（如 "index.md", "medical_history.md", "medication_plan.md", "communication_timeline.md"），Value 是更新后的完整 Markdown 内容。
4. **输出限制**：请不要有任何的解释性前缀、后缀，也不要用 \`\`\`json 标记。直接输出 JSON 内容。如果某个文件不需要修改，也请把修改后的（与原内容一致）完整内容放进 Value 中。

示例输出格式:
{
  "index.md": "# 客户健康首页...",
  "medical_history.md": "# 既往史与诊疗时间轴...",
  "medication_plan.md": "# 用药方案...",
  "communication_timeline.md": "# 随访互动..."
}`;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.ARK_MODEL || 'doubao-1.5-pro-32k-250115',
      messages: [
        { role: 'system', content: 'You are a professional assistant that outputs strict JSON only. Do not include markdown codeblocks or extra text.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    });

    const contentText = response.choices[0]?.message?.content || '{}';
    
    // 清理大模型可能输出的 ```json 和 ``` 标记
    let cleanedText = contentText.trim();
    if (cleanedText.startsWith('```')) {
      const match = cleanedText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) cleanedText = match[1].trim();
    }

    const updatedWiki = JSON.parse(cleanedText);

    // 验证返回的 Wiki 页面是否包含必要的 md 文件，避免模型输出错误覆盖原档案
    const fileKeys = ['index.md', 'medical_history.md', 'medication_plan.md', 'communication_timeline.md'];
    const validUpdate = fileKeys.some(key => updatedWiki[key]);

    if (!validUpdate) {
      throw new Error('大模型未能返回有效的 Wiki 页面 JSON 数据');
    }

    // 写入更新的 Wiki
    writeWikiPages(id, updatedWiki);

    // 将这些 logs 标记为已同步
    logs.forEach(l => {
      if (!l.synced) l.synced = true;
    });
    writeLogs(id, logs);

    // 更新客户最后同步时间
    client.lastSyncAt = new Date().toISOString();
    writeClients(clients);

    res.json({
      message: 'Wiki 同步更新成功！',
      wikiUpdated: true,
      updatedFiles: Object.keys(updatedWiki)
    });

  } catch (err) {
    console.error('豆包模型同步失败:', err);
    res.status(500).json({ error: '同步过程中调用大模型失败: ' + err.message });
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
    const response = await openai.chat.completions.create({
      model: process.env.ARK_MODEL || 'doubao-1.5-pro-32k-250115',
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

// 启动服务器
app.listen(PORT, () => {
  console.log(`LLM Wiki 后端服务运行在端口 ${PORT}`);
});
