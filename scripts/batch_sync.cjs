#!/usr/bin/env node
/**
 * batch_sync.cjs v3
 * - 按文件职责过滤事实，减小单次 prompt 体积
 * - 自动重试（3次，间隔3s）
 * - 详细进度日志
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');

dotenv.config({ path: path.join(__dirname, '../.env') });

const DATA_DIR   = path.join(__dirname, '../data');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const WIKI_DIR   = path.join(DATA_DIR, 'wiki');
const LOGS_DIR   = path.join(DATA_DIR, 'logs');

const openai = new OpenAI({
  apiKey:   process.env.ARK_API_KEY,
  baseURL:  process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
  timeout:  60000,   // 60s 超时
});
const MODEL = process.env.ARK_MODEL || 'doubao-1.5-pro-32k-250115';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function readWiki(clientId) {
  const dir = path.join(WIKI_DIR, clientId);
  if (!fs.existsSync(dir)) return {};
  const pages = {};
  fs.readdirSync(dir).filter(f => f.endsWith('.md')).forEach(f => {
    pages[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  });
  return pages;
}

// 每个文件只接收相关类型的事实，减少 prompt 长度
const FILE_FACT_FILTER = {
  'index.md': f =>
    f.type === 'observation' && ['signal','functional'].includes(f.subtype) && f.attention_score >= 0.7,
  'medical_history.md': f =>
    f.type === 'observation',   // 所有观察类
  'medication_plan.md': f =>
    f.type === 'intervention',  // 所有干预类
  'communication_timeline.md': f => true,  // 所有事实（作为证据记录）
};

const FILE_ROLES = {
  'index.md':
    '患者健康首页：只写高危预警信号（attention≥0.7的signal/functional观察）和事件时间轴摘要。',
  'medical_history.md':
    '既往史与诊疗时间轴：写所有生理信号、化验影像结果、功能变化等观察。',
  'medication_plan.md':
    '用药方案与生活医嘱：只写干预措施（药物、管路、护理、防护操作）。',
  'communication_timeline.md':
    '随访互动摘要：监测目标和所有原始溯源证据时间线。',
};

async function callWithRetry(fn, retries = 3, delayMs = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i < retries - 1) {
        process.stdout.write(`[重试${i+1}]`);
        await sleep(delayMs);
      } else {
        throw err;
      }
    }
  }
}

async function updateOneFile(fileName, currentContent, filteredFacts) {
  if (filteredFacts.length === 0) {
    return null; // 没有相关事实，不更新这个文件
  }

  // 限制当前内容长度（保留结构，截断过长的正文）
  const maxCurrentLen = 1500;
  const truncatedContent = currentContent.length > maxCurrentLen
    ? currentContent.slice(0, maxCurrentLen) + '\n\n...(已截断，请在现有结构基础上追加)'
    : currentContent;

  const factsText = filteredFacts.map((f, i) =>
    f.type === 'observation'
      ? `[#${i}] 类型:obs/${f.subtype} 关注度:${f.attention_score} 溯源:${f.log_id}\n内容:"${f.content}"`
      : `[#${i}] 类型:int/${f.subtype} 溯源:${f.log_id}\n内容:"${f.content}"`
  ).join('\n\n');

  const prompt = `你是医疗档案助理。请根据【新增事实】更新以下单个 Wiki 页面。

文件: ${fileName}
职责: ${FILE_ROLES[fileName]}

【当前内容】
${truncatedContent}

【新增事实（共${filteredFacts.length}条）】
${factsText}

【要求】
- 在合适章节追加新事实，不要删除已有内容
- observation事实用：
\`\`\`observation-block
type: observation
subtype: signal|finding|functional
content: "内容"
evidence_refs:
  - 溯源ID
attention_score: 分数
\`\`\`
- intervention事实用：
\`\`\`intervention-block
type: intervention
subtype: treatment|pipeline|protection|care
content: "内容"
evidence_refs:
  - 溯源ID
\`\`\`
- 禁止: AI确诊/AI诊断/危及生命/life-threatening
- 直接输出完整 Markdown，不要 JSON 包装`;

  return await callWithRetry(() =>
    openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: '直接输出 Markdown 文本。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 2500,
    }).then(r => r.choices[0].message.content.trim())
  );
}

async function syncClient(client, logs) {
  const unsyncedLogs = logs.filter(l => !l.synced);
  if (unsyncedLogs.length === 0) {
    console.log(`  [跳过] ${client.name} — 无未同步记录`);
    return false;
  }

  // Stage 1
  process.stdout.write(`  [S1] 提取事实... `);
  const s1Prompt = `从以下医疗沟通记录提取所有临床事实。严禁编造，每条需注明来源ID。

记录：
${unsyncedLogs.map(l => `--- [ID:${l.id}][${l.type}] ${l.title} ---\n${l.content}`).join('\n\n')}

输出JSON：{"facts":[{"type":"observation|intervention","subtype":"signal|finding|functional|treatment|pipeline|protection|care","content":"具体内容","log_id":"log_xxx"}]}`;

  const s1Res = await callWithRetry(() =>
    openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'Output strict JSON only.' },
        { role: 'user', content: s1Prompt }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
      max_tokens: 3000,
    })
  );
  const facts = (JSON.parse(s1Res.choices[0].message.content).facts || []);
  console.log(`${facts.length} 个事实`);

  // Stage 2: 本地计算 attention_score
  facts.forEach(f => {
    if (f.type !== 'observation') return;
    let score = 0.3;
    const t = f.content;
    const spo2 = t.match(/(\d{2,3})\s*%/);
    if (/血氧|spo2/i.test(t) && spo2) {
      score = Math.max(score, parseInt(spo2[1]) < 90 ? 0.95 : parseInt(spo2[1]) < 94 ? 0.75 : 0.3);
    }
    const bp = t.match(/(\d{3})\/\d{2,3}/);
    if (bp) score = Math.max(score, parseInt(bp[1]) >= 180 ? 0.92 : parseInt(bp[1]) >= 140 ? 0.65 : 0.3);
    const bg = t.match(/血糖.*?(\d+\.?\d*)\s*mmol/);
    if (bg) score = Math.max(score, parseFloat(bg[1]) > 10 ? 0.88 : parseFloat(bg[1]) > 7 ? 0.65 : 0.3);
    ['昏迷','嗜睡','失语','偏瘫','脑出血','呼吸衰竭','窒息','脑疝'].forEach(k => { if (t.includes(k)) score = Math.max(score, 0.92); });
    ['骨折','发热','气促','低血压','压疮高危','跌倒高危','SpO2'].forEach(k => { if (t.includes(k)) score = Math.max(score, 0.75); });
    f.attention_score = parseFloat(score.toFixed(2));
  });

  // Stage 3: 逐文件，带过滤
  const currentWiki = readWiki(client.id);
  const clientWikiDir = path.join(WIKI_DIR, client.id);
  if (!fs.existsSync(clientWikiDir)) fs.mkdirSync(clientWikiDir, { recursive: true });

  let successCount = 0;
  for (const fileName of ['index.md', 'medical_history.md', 'medication_plan.md', 'communication_timeline.md']) {
    const filteredFacts = facts.filter(FILE_FACT_FILTER[fileName]);
    process.stdout.write(`  [S3] ${fileName}（${filteredFacts.length}条相关事实）... `);

    if (filteredFacts.length === 0) {
      console.log('跳过（无相关事实）');
      successCount++;
      continue;
    }

    try {
      const newContent = await updateOneFile(fileName, currentWiki[fileName] || '', filteredFacts);
      if (newContent) {
        fs.writeFileSync(path.join(clientWikiDir, fileName), newContent, 'utf8');
        const blocks = (newContent.match(/observation-block|intervention-block/g) || []).length;
        console.log(`✅ ${blocks}个块`);
        successCount++;
      }
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 50)}`);
    }

    await sleep(1000); // 每个文件之间间隔1秒，防止限速
  }

  if (successCount === 0) throw new Error('所有文件均失败');

  logs.forEach(l => l.synced = true);
  fs.writeFileSync(path.join(LOGS_DIR, `${client.id}.json`), JSON.stringify(logs, null, 2));

  const clients = readJson(CLIENTS_FILE);
  const idx = clients.findIndex(c => c.id === client.id);
  if (idx >= 0) {
    clients[idx].lastSyncAt = new Date().toISOString();
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
  }

  console.log(`  ✅ ${client.name} 完成 (${successCount}/4 文件)`);
  return true;
}

async function main() {
  const clients = readJson(CLIENTS_FILE);
  const TARGET_IDS = [
    'case_combined_elderly',
    'case_combined_crohn_wearable',
    'case_combined_stroke_multichannel',
    'case_combined_pediatric'
  ];
  for (const client of clients.filter(c => TARGET_IDS.includes(c.id))) {
    console.log(`\n🔄 ${client.name}`);
    const logs = readJson(path.join(LOGS_DIR, `${client.id}.json`)) || [];
    try {
      await syncClient(client, logs);
    } catch (err) {
      console.error(`  ❌ 失败: ${err.message}`);
    }
    await sleep(2000); // 案例之间间隔2秒
  }
  console.log('\n🎉 全部完成！');
}

main().catch(console.error);
