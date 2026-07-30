/**
 * wiki_sync_trigger.cjs
 * Agent 侧集成模块 —— 负责与 LLMWiki 的所有交互。
 * 包含：buildSystemPrompt / ConversationWindow / WikiSyncTrigger / getWikiTools / HealthAgent
 */
'use strict';

const LLMWIKI_BASE = process.env.LLMWIKI_BASE || 'http://localhost:5050';

// ── 1. System Prompt 构建器 ──
async function buildSystemPrompt(userId, fixedInstruction = '') {
  try {
    const response = await fetch(`${LLMWIKI_BASE}/api/clients/${userId}/context-inject`);
    if (!response.ok) {
      console.warn(`[WikiSync] context-inject 失败 (${response.status})，使用空档案继续`);
      return fixedInstruction;
    }
    const { user_profile, health_wiki, token_estimate } = await response.json();
    console.log(`[WikiSync] 档案注入 token 估算: ${token_estimate.total}`);
    return `${fixedInstruction}

---
## 用户画像与沟通注意点
${user_profile || '（暂无用户画像信息）'}

---
## 用户健康档案（当前关注摘要）
${health_wiki || '（暂无健康档案）'}
`.trim();
  } catch (err) {
    console.error('[WikiSync] 拉取档案失败，使用空档案继续:', err.message);
    return fixedInstruction;
  }
}

// ── 2. 对话历史管理器（30 轮滚动窗口） ──
class ConversationWindow {
  constructor(maxRounds = 30) {
    this.maxRounds = maxRounds;
    this.history = [];
    this.totalRounds = 0; // 累计轮次，用于 prefetch 切换判断（>30 启用）
  }

  addRound(userMsg, assistantMsg) {
    this.history.push({ role: 'user', content: userMsg });
    this.history.push({ role: 'assistant', content: assistantMsg });
    this.totalRounds++;
    while (this.history.length > this.maxRounds * 2) {
      this.history.splice(0, 2);
    }
  }

  getHistory() { return [...this.history]; }

  estimateTokens() {
    const totalChars = this.history.reduce((sum, m) => sum + m.content.length, 0);
    const chineseChars = this.history.reduce(
      (sum, m) => sum + (m.content.match(/[\u4e00-\u9fff]/g) || []).length, 0
    );
    return Math.ceil(chineseChars * 0.6 + (totalChars - chineseChars) * 0.25);
  }

  shouldUsePrefetch() { return this.totalRounds > 30; }
}

// ── 3. 同步触发器 ──
class WikiSyncTrigger {
  constructor(userId, llmwikiBase = LLMWIKI_BASE) {
    this.userId = userId;
    this.llmwikiBase = llmwikiBase;
    this.counter = 0;
    this.COUNTER_LIMIT = 30;
    this.TOKEN_SAFETY_LIMIT = 80000;
  }

  // 每轮结束后调用（不 await）
  onTurnEnd(userMsg, assistantMsg, currentTokenEstimate = 0) {
    this.counter++;
    this._backgroundPostLog(userMsg, assistantMsg);
    if (currentTokenEstimate > this.TOKEN_SAFETY_LIMIT) {
      console.log('[WikiSync] ⚠️  Token 安全阈值触发 sync');
      this._backgroundSync('token_safety');
      this.counter = 0;
    } else if (this.counter >= this.COUNTER_LIMIT) {
      console.log('[WikiSync] 📊 30 轮计数器触发 sync');
      this._backgroundSync('counter');
      this.counter = 0;
    }
  }

  // Skill 完成时调用（方案A：await sync 再返回，保证后续刷新能拿到新 wiki）
  async onSkillComplete(skillName) {
    console.log(`[WikiSync] ✅ Skill 完成触发 sync: ${skillName}`);
    const success = await this._doSync('skill_complete');
    this.counter = 0;
    return success;
  }

  _backgroundPostLog(userMsg, assistantMsg) {
    fetch(`${this.llmwikiBase}/api/clients/${this.userId}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'wechat',
        content: `用户：${userMsg}\nAI：${assistantMsg}`,
        title: `对话记录 ${new Date().toLocaleString('zh-CN')}`
      })
    }).catch(() => {});
  }

  _backgroundSync(reason) {
    this._doSync(reason).catch(err => {
      console.error(`[WikiSync] 后台 sync 失败 (${reason}):`, err.message);
    });
  }

  async _doSync(reason) {
    try {
      const response = await fetch(
        `${this.llmwikiBase}/api/clients/${this.userId}/sync`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      console.log(`[WikiSync] sync 完成 (reason: ${reason}, updated: ${result.wikiUpdated})`);
      return true;
    } catch (err) {
      console.error(`[WikiSync] sync 失败 (reason: ${reason}):`, err.message);
      return false;
    }
  }
}

// ── 4. Agent 工具定义 ──
function getWikiTools(userId) {
  return [
    {
      name: 'get_medical_history',
      description: '获取用户的详细历史病史、生理信号记录（血压/血氧/血糖等）和化验结果。当用户询问具体检查指标、病史细节时调用。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        try {
          const res = await fetch(`${LLMWIKI_BASE}/api/clients/${userId}/wiki`);
          const pages = await res.json();
          return pages['medical_history.md'] || '（暂无历史病史记录）';
        } catch (err) { return `（读取失败: ${err.message}）`; }
      }
    },
    {
      name: 'get_medication_plan',
      description: '获取用户的当前用药方案、护理要程、生活医嘱和监测目标。当用户询问用药、护理细节或监测指标目标值时调用。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        try {
          const res = await fetch(`${LLMWIKI_BASE}/api/clients/${userId}/wiki`);
          const pages = await res.json();
          return pages['medication_plan.md'] || '（暂无用药方案记录）';
        } catch (err) { return `（读取失败: ${err.message}）`; }
      }
    }
  ];
}

module.exports = { buildSystemPrompt, ConversationWindow, WikiSyncTrigger, getWikiTools, LLMWIKI_BASE };
