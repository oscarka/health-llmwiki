/**
 * 大模型转发：前端不再直连方舟（浏览器网络不稳时会 Failed to fetch，且密钥不能放前端）。
 *  - 前端把 messages 等发到 POST /api/llm/chat，后端带自己的密钥去方舟，响应原样返回（OpenAI 兼容格式），前端解析逻辑不变。
 *  - 模型固定用服务端配置，忽略前端传的 model；限制输入长度、max_tokens 与每个 IP 的调用频率，防滥用。
 *  - 429 / 5xx / 超时 / 网络错误在后端自动重试；只记录状态、耗时、token 数，不记录对话内容。
 */
const MAX_CHARS = 150000;      // 单次输入字符上限
const MAX_TOKENS = 8000;
const TIMEOUT_MS = 100000;
const TRIES = 3;
const RATE_PER_MIN = 90;

const hits = new Map();        // ip -> [时间戳]
function rateLimited(ip) {
  const now = Date.now(); const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
  return arr.length > RATE_PER_MIN;
}

function registerLlmProxy(app) {
  app.post('/api/llm/chat', async (req, res) => {
    const t0 = Date.now();
    try {
      const key = process.env.ARK_API_KEY;
      const base = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
      const model = process.env.ARK_MODEL || process.env.SYNC_MODEL;
      if (!key || !model) return res.status(500).json({ error: '服务端未配置大模型' });
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      if (rateLimited(ip)) return res.status(429).json({ error: '调用太频繁，请稍后再试' });

      const b = req.body || {};
      const messages = Array.isArray(b.messages) ? b.messages.filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role)) : [];
      if (!messages.length) return res.status(400).json({ error: 'messages 不能为空' });
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      if (chars > MAX_CHARS) return res.status(413).json({ error: `输入过长（${chars} 字，上限 ${MAX_CHARS}）` });
      const body = {
        model, messages,
        temperature: typeof b.temperature === 'number' ? Math.min(2, Math.max(0, b.temperature)) : 0.3,
        max_tokens: Math.min(MAX_TOKENS, Math.max(1, Number(b.max_tokens) || 3000)),
      };
      if (b.thinking && ['disabled', 'enabled'].includes(b.thinking.type)) body.thinking = { type: b.thinking.type };

      let lastStatus = 0, lastText = '';
      for (let attempt = 1; attempt <= TRIES; attempt++) {
        try {
          const r = await fetch(`${base}/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          const text = await r.text();
          if (r.ok) {
            let usage = ''; try { const j = JSON.parse(text); usage = `prompt_tok=${j.usage && j.usage.prompt_tokens} out_tok=${j.usage && j.usage.completion_tokens}`; } catch (e) { /* ignore */ }
            console.log(`[LLMProxy] ok attempt=${attempt} chars=${chars} total_ms=${Date.now() - t0} ${usage}`);
            return res.status(200).type('application/json').send(text);
          }
          lastStatus = r.status; lastText = text.slice(0, 300);
          console.warn(`[LLMProxy] ark status=${r.status} attempt=${attempt}/${TRIES} ms=${Date.now() - t0} body=${lastText.slice(0, 120)}`);
          if (!(r.status === 429 || r.status >= 500)) break; // 4xx（非限流）不重试
        } catch (e) {
          lastStatus = 0; lastText = e && (e.name === 'TimeoutError' ? '模型响应超时' : e.message);
          console.warn(`[LLMProxy] network attempt=${attempt}/${TRIES} ms=${Date.now() - t0} err=${lastText}`);
        }
        if (attempt < TRIES) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
      console.error(`[LLMProxy] FAILED chars=${chars} total_ms=${Date.now() - t0} lastStatus=${lastStatus}`);
      res.status(lastStatus >= 400 && lastStatus < 500 ? lastStatus : 502).json({ error: `大模型调用失败${lastStatus ? `（${lastStatus}）` : ''}：${lastText || '网络错误'}` });
    } catch (err) {
      console.error('[LLMProxy] error:', err && err.message);
      res.status(500).json({ error: '大模型转发出错：' + (err && err.message) });
    }
  });
}

module.exports = { registerLlmProxy };
