/**
 * 「营养师饮食方案」：免费给用户用一次营养师 skill 的方法，生成第一版；之后按用户的修改意见出新版本。
 *
 * 做法 = 计划协调器对比测试里胜出的“方案 E”（见 skill-platform/doc/plan_coord_bench_report.md）：
 *   把【硬约束清单】写进 skill 的输入 → 要求模型“先列约束、再起草、再逐条自查” → 程序只做不粗暴的校验，一次模型调用。
 *   教训：程序兜底不能粗暴 —— 不丢整条、不覆盖已有内容；有疑点只“打标提醒”，不悄悄删改。
 *
 * 营养师方法来自平台里的「AI营养师(Agent专用)」skill（id 0418bc5c…，《中国居民膳食指南2022》/DRIs；中国胃优先；
 * 方案要含每餐具体吃什么和大致份量）。该 skill 目前是“未审核、未打包”状态，而且慢病只覆盖糖尿病/高血压/痛风/高血脂，
 * 不含心衰的限盐限液——所以这里不照搬它的慢病结论，而是把【医嘱限制】当作最高优先级的硬约束。
 */
const mp = require('./materialPlan.cjs');

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const extractJson = (raw) => { const m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; } };
const SLOTS = ['早餐', '上午加餐', '午餐', '下午加餐', '晚餐', '睡前加餐'];

const SKILL_METHOD = `【营养师方法（来自“AI营养师”skill）】
- 依据《中国居民膳食指南2022》；中国胃优先：以家常中式做法为主，食材常见、做饭简单。
- 方案要“可直接照着吃”：每餐写出具体吃什么、大致份量（用“一小碗/半根/一个拳头大小/约XXg”这类家常说法）。
- 少盐少油少糖；优质蛋白、蔬菜、全谷物合理搭配；先看用户资料里的过敏/忌口/饮食习惯。
- 营养教育工具，不替代医生/注册营养师意见；慢病患者一律“遵医嘱”。`;

function buildPrompt({ constraints, profile, previous, feedback }) {
  const system = `你是营养师助手，要给一位用户生成“一周内可轮换的饮食参考套餐”。你不是医生，只做饮食安排，不诊断、不推荐药物或保健品、不改任何医嘱。
${SKILL_METHOD}

【最高优先级：硬约束清单】下面每一条都来自医生医嘱或用户资料，任何一餐都不得违反；与营养师常识冲突时，一律以硬约束为准。
请严格分三步做（把过程写进 JSON）：
第 1 步 constraints：把硬约束逐条复述，并写出“这对吃饭意味着什么”（如“少进液体（汤、水、奶、茶）→ 不安排汤粥、不额外喝奶茶；主食菜肴以干为主”）。
第 2 步 sets：起草 3 套可轮换的一日套餐（套餐A/B/C），每套含 早餐、午餐、晚餐，并按需要加 1~2 次加餐；每餐 2~4 样具体食物，各带家常份量。
第 3 步 self_check：对每条硬约束逐条自查你起草的 3 套套餐是否都满足（ok=true/false 与说明）；发现违反就先改套餐再输出，不要带着违规输出。
另外：
- avoid：列出 3~6 条“要避免的”（来自硬约束或常识，常识类要标“常识”）。
- 药物与食物的相互作用只在你非常确定且常见时才写（如降压药与西柚），写在 avoid 里并标“常识”，不得编造。
- 不写热量/营养素的精确数字；份量用家常说法即可。
- 如果有“上一版方案”和“用户的修改意见”：在上一版基础上只改用户提到的部分，其余保持不变；用户的意见若与硬约束冲突，不照做，把原因写进 notes。
只输出 JSON：
{"constraints":[{"text":"","meaning":""}],
 "sets":[{"name":"套餐A","meals":[{"slot":"早餐","items":[{"food":"","amount":""}],"tip":""}]}],
 "avoid":[{"text":"","basis":"医嘱|资料|常识"}],
 "self_check":[{"constraint":"","ok":true,"note":""}],
 "notes":"给用户的一句话说明（含：这是参考建议，不是医嘱）"}`;
  const user = JSON.stringify({ hard_constraints: constraints, profile: clip(profile, 1500), previous_version: previous || null, user_feedback: clip(feedback, 300) || null });
  return { system, user };
}

/** 程序校验：形状、数量、是否自查通过；有疑点只标记（flags），不删不改 */
function validate(out, hasLiquidRestriction) {
  if (!out || !Array.isArray(out.sets) || !out.sets.length) return { error: '方案格式不对' };
  const sets = out.sets.slice(0, 3).map((s, i) => ({
    name: clip(s.name, 12) || `套餐${'ABC'[i]}`,
    meals: (Array.isArray(s.meals) ? s.meals : []).slice(0, 6).map((m) => ({
      slot: SLOTS.includes(m.slot) ? m.slot : clip(m.slot, 8) || '加餐',
      items: (Array.isArray(m.items) ? m.items : []).slice(0, 6).map((it) => ({ food: clip(it.food, 24), amount: clip(it.amount, 24) })).filter((it) => it.food),
      tip: clip(m.tip, 60),
    })).filter((m) => m.items.length),
  })).filter((s) => s.meals.length >= 2);
  if (!sets.length) return { error: '方案里没有可用的餐次' };
  const flags = [];
  // 只扫“食物名”（不扫提示语，提示里常写“不喝面汤”这类否定句，会误报）
  const foodText = sets.map((s) => s.meals.map((m) => m.items.map((it) => it.food).join(' ')).join(' ')).join(' ').replace(/山药|茶树菇/g, '');
  if (/药|保健品|补充剂|维生素[A-Z]片/.test(foodText)) flags.push('方案里出现了“药/补充剂”相关字样，请忽略其中任何用药建议，只按医嘱用药');
  if (hasLiquidRestriction && /汤|粥|牛奶|酸奶|羊奶|豆浆|奶茶|茶|饮料|果汁|羹|糊/.test(foodText)) flags.push('您的医嘱要求少进液体：方案里个别餐可能含汤/粥/奶/茶等，请按医嘱控制总量，必要时换成干的做法');
  const sc = Array.isArray(out.self_check) ? out.self_check.slice(0, 12).map((c) => ({ constraint: clip(c.constraint, 80), ok: c.ok !== false, note: clip(c.note, 100) })) : [];
  if (sc.some((c) => !c.ok)) flags.push('AI 自查时发现有一条约束没完全满足，请以医嘱为准、有疑问先问医生');
  return {
    plan: {
      constraints: (Array.isArray(out.constraints) ? out.constraints : []).slice(0, 10).map((c) => ({ text: clip(c.text, 80), meaning: clip(c.meaning, 120) })),
      sets,
      avoid: (Array.isArray(out.avoid) ? out.avoid : []).slice(0, 8).map((a) => ({ text: clip(a.text, 60), basis: ['医嘱', '资料', '常识'].includes(a.basis) ? a.basis : '常识' })),
      self_check: sc, notes: (() => { const n = clip(out.notes, 160); return /不是医嘱|非医嘱/.test(n) ? n : (n ? n + ' ' : '') + '以上是营养师参考建议，不是医嘱，以医生意见为准。'; })(), flags,
    },
  };
}

function registerNutrition(app, { db, findClient, planApi, getProfileText }) {
  // 注意：这里不能关模型“推理”。实测（同一约束各跑 6 次）：推理开 违规 0/6、约 100 秒；推理关 违规 5/6、约 19 秒；reasoning_effort=low 5/6、minimal 6/6。所以方案生成改为后台任务 + 轮询
  const llm = (s, u, t) => mp.makeArkLlm({ key: process.env.ARK_API_KEY, url: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3', model: process.env.ARK_MODEL || process.env.SYNC_MODEL })(s, u, t);
  const ready = db.query(`CREATE TABLE IF NOT EXISTS llmwiki.plan_nutrition (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, version INT NOT NULL, plan_id TEXT, plan_version INT,
    content JSONB NOT NULL, feedback TEXT, created_at BIGINT NOT NULL)`, []).catch((e) => console.error('[Nutrition] ensureTables failed:', e.message));
  const rid = () => `nu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const latest = async (id) => (await db.query(`SELECT * FROM llmwiki.plan_nutrition WHERE client_id=$1 ORDER BY version DESC LIMIT 1`, [id])).rows[0] || null;
  const shape = (r) => r && ({ id: r.id, version: r.version, plan_id: r.plan_id, plan_version: r.plan_version, feedback: r.feedback, created_at: Number(r.created_at), ...r.content });
  const running = new Set();

  // 硬约束清单：来自生效计划里的饮食/其它限制（原文），不由程序用关键词判断
  const hardConstraints = (active) => (active ? active.items.filter((i) => i.line !== 'medication' && i.line !== 'monitor').map((i) => clip(i.evidence || i.title, 80)) : []);

  app.get('/api/clients/:id/plans/nutrition', async (req, res) => {
    try { await ready; if (!await findClient(req.params.id)) return res.status(404).json({ error: '客户不存在' }); res.json({ nutrition: shape(await latest(req.params.id)) }); }
    catch (e) { res.status(500).json({ error: '读取饮食方案失败: ' + e.message }); }
  });

  const jobs = new Map(); // jobId -> { status, error?, nutrition?, clientId, createdAt }
  setInterval(() => { const now = Date.now(); for (const [k, v] of jobs) if (now - v.createdAt > 30 * 60 * 1000) jobs.delete(k); }, 5 * 60 * 1000).unref();

  // 生成：第一版（每个客户免费一次）或按修改意见出新版本。立即返回 202 + jobId，前端轮询
  app.post('/api/clients/:id/plans/nutrition/generate', async (req, res) => {
    const id = req.params.id;
    try {
      await ready; if (!await findClient(id)) return res.status(404).json({ error: '客户不存在' });
      if (!process.env.ARK_API_KEY) return res.status(503).json({ error: '生成服务未配置' });
      const feedback = clip(req.body && req.body.feedback, 300);
      const prev = await latest(id);
      if (prev && !feedback) return res.status(409).json({ error: '已有饮食方案；如需调整请写下修改意见', nutrition: shape(prev) });
      if (!prev && feedback) return res.status(400).json({ error: '还没有第一版方案' });
      if (running.has(id)) return res.status(429).json({ error: '正在生成中，请稍候' });
      if (prev && (Date.now() - Number(prev.created_at)) < 20 * 1000) return res.status(429).json({ error: '操作太频繁，请稍后再试' });
      running.add(id);
      const job = { id: rid(), clientId: id, status: 'running', createdAt: Date.now() }; jobs.set(job.id, job);
      res.status(202).json({ jobId: job.id });
      (async () => {
        try {
          const active = await planApi.getActive(id); const profile = await getProfileText(id);
          const constraints = hardConstraints(active);
          const { system, user } = buildPrompt({ constraints, profile, previous: prev ? prev.content : null, feedback });
          const hasLiquid = !!active && constraints.some((c) => /液体|限水|饮水/.test(c)); // 仅用于“打标提醒/触发一次修正”，不决定任何内容
          const T = 240000;
          let v = validate(extractJson(await llm(system, user, T)), hasLiquid);
          if (v.error) v = validate(extractJson(await llm(system, user, T)), hasLiquid); // 格式不对重试一次
          if (v.error) { job.status = 'error'; job.error = '生成失败：' + v.error + '，请稍后重试'; return; }
          // 方案E的“检查”环节：发现限液冲突时，让模型按“只改违规的那几样”再出一版；不由程序直接改写内容
          for (let pass = 0; pass < 2 && hasLiquid && v.plan.flags.some((f) => /少进液体/.test(f)); pass++) {
            const bad = [...new Set((JSON.stringify(v.plan.sets.map((s) => s.meals.map((m) => m.items.map((it) => it.food)))).match(/[^\"\[\],]*(汤|粥|牛奶|酸奶|羊奶|豆浆|奶茶|茶|饮料|果汁|羹|糊)[^\"\[\],]*/g)) || [])];
            if (!bad.length) break;
            const fb = `【系统自查】下列食物与医嘱“少进液体”冲突：${bad.join('、')}。请只把这些换成干的做法或干的食物，其余内容保持不变。`;
            const p2 = buildPrompt({ constraints, profile, previous: v.plan, feedback: fb });
            try { const v2 = validate(extractJson(await llm(p2.system, p2.user, T)), hasLiquid); if (!v2.error) v = v2; } catch (e) { console.error('[Nutrition] repair pass failed:', e && e.message); }
          }
          const version = prev ? prev.version + 1 : 1;
          const content = { ...v.plan, hard_constraints: constraints, basis: active ? 'plan' : 'profile_only', generated_by: 'nutritionist_method_E' };
          await db.query(`INSERT INTO llmwiki.plan_nutrition (id, client_id, version, plan_id, plan_version, content, feedback, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [rid(), id, version, active ? active.id : null, active ? active.version : null, JSON.stringify(content), feedback || null, Date.now()]);
          job.nutrition = shape(await latest(id)); job.status = 'done';
        } catch (e) { console.error('[Nutrition] generate failed:', e && e.stack || e); job.status = 'error'; job.error = '生成饮食方案失败: ' + (e && e.message); }
        finally { running.delete(id); }
      })();
    } catch (e) { running.delete(id); console.error('[Nutrition] generate failed:', e && e.stack || e); if (!res.headersSent) res.status(500).json({ error: '生成饮食方案失败: ' + e.message }); }
  });

  app.get('/api/clients/:id/plans/nutrition/jobs/:jobId', (req, res) => {
    const j = jobs.get(req.params.jobId);
    if (!j || j.clientId !== req.params.id) return res.status(404).json({ error: '任务不存在或已过期' });
    res.json({ status: j.status, error: j.error, nutrition: j.nutrition, elapsed_s: Math.round((Date.now() - j.createdAt) / 1000) });
  });
}

module.exports = { registerNutrition, buildPrompt, validate };
