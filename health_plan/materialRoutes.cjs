/**
 * 「医院材料 → 健康计划」接口（见 skill-platform/doc/material_plan_rigor_availability_report.md）
 *
 * 流程：上传图片 → 看图提取+漏项复查（异步任务） → 用户核对/修改/接受漏项 → 生成计划草稿（异步任务，程序校验+重试+兜底）
 *       → 草稿等用户在"健康计划"里点确认才生效（沿用 healthPlan 的 proposal/confirm）。
 * 设计要点：
 *  - 提取结果保存在服务端（extractionId），生成时只接受"用户的修改决定"，客户端不能改材料类型/日期等关键字段。
 *  - 图片只在内存里处理，不落盘、不入库；日志里不打印提取内容。
 *  - 异步任务：手机网络中途断开也不会丢，前端轮询。
 *  - 限流：每个客户每小时最多 8 个任务；全局最多 5 个任务同时进行。
 */
const mp = require('./materialPlan.cjs');

const MAX_IMAGES = 6, MAX_TOTAL_B64 = 9 * 1024 * 1024, JOB_TTL = 30 * 60 * 1000;
const PER_CLIENT_PER_HOUR = 8, GLOBAL_RUNNING = 5;

const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const rid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
// 仅测试命名空间（test_sandbox_* / mini_199*）允许指定"今天是哪天"，用来在有限的真实样本上测试"较新/较旧"两种分级；真实用户一律用真实日期。
const asOfFor = (clientId, v) => (/^(test_sandbox_|mini_199)/.test(clientId) && /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : today());

function registerMaterialPlan(app, { findClient, planApi }) {
  const jobs = new Map(), extractions = new Map(), history = new Map();
  const cfg = () => ({ key: process.env.ARK_API_KEY, url: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3' });
  const llm = (s, u, t) => mp.makeArkLlm({ ...cfg(), model: process.env.ARK_MODEL || process.env.SYNC_MODEL })(s, u, t);
  // 视觉模型偶发排队：同样输出 27 token 的调用有时 3 秒、有时 108 秒（线上日志实测）。等不到 40 秒就并行再发一个，谁先成功用谁；第一个直接失败也立即补发。
  const hedge = (fn, delayMs = 40000) => (p, b, t) => new Promise((resolve, reject) => {
    let done = false, n = 0, fails = 0; let tm = null;
    const start = () => { n++; fn(p, b, t).then((v) => { if (!done) { done = true; clearTimeout(tm); resolve(v); } }).catch((e) => { fails++; if (done) return; if (n < 2) { clearTimeout(tm); start(); } else if (fails >= n) { done = true; reject(e); } }); };
    tm = setTimeout(() => { if (!done && n < 2) start(); }, delayMs); start();
  });
  const vision = hedge((p, b, t) => mp.makeArkVision({ ...cfg(), model: process.env.VISION_MODEL || 'doubao-seed-2-0-mini-260428' })(p, b, t));

  setInterval(() => { const now = Date.now(); for (const m of [jobs, extractions]) for (const [k, v] of m) if (now - v.createdAt > JOB_TTL) m.delete(k); }, 5 * 60 * 1000).unref();

  const gate = (clientId) => {
    const now = Date.now(); const h = (history.get(clientId) || []).filter((t) => now - t < 3600 * 1000);
    if (h.length >= PER_CLIENT_PER_HOUR) return `操作太频繁（每小时最多 ${PER_CLIENT_PER_HOUR} 次），请稍后再试`;
    if ([...jobs.values()].filter((j) => j.status === 'running').length >= GLOBAL_RUNNING) return '系统正忙，请 1 分钟后再试';
    h.push(now); history.set(clientId, h); return null;
  };
  const startJob = (clientId, kind, fn) => {
    const job = { id: rid('mj'), clientId, kind, status: 'running', stage: '排队中', createdAt: Date.now() };
    jobs.set(job.id, job);
    fn((stage) => { job.stage = stage; }).then((result) => { job.status = 'done'; job.result = result; }).catch((e) => { job.status = 'error'; job.error = String(e && e.message || e).slice(0, 200); console.error('[MaterialPlan] job failed:', kind, job.error); });
    return job;
  };
  const needClient = async (req, res) => { if (!await findClient(req.params.id)) { res.status(404).json({ error: '客户不存在' }); return false; } return true; };

  // 1. 上传 → 提取
  app.post('/api/clients/:id/plans/material/extract', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const imgs = Array.isArray(req.body && req.body.images) ? req.body.images : [];
      if (!imgs.length) return res.status(400).json({ error: '请至少上传一张材料图片' });
      if (imgs.length > MAX_IMAGES) return res.status(400).json({ error: `一次最多上传 ${MAX_IMAGES} 张` });
      const b64s = imgs.map((s) => String(s || '').replace(/^data:image\/[a-zA-Z+]+;base64,/, ''));
      if (b64s.some((s) => s.length < 200 || !/^[A-Za-z0-9+/=\s]+$/.test(s.slice(0, 400)))) return res.status(400).json({ error: '有图片无法读取，请重新选择（支持 JPG/PNG 照片）' });
      if (b64s.reduce((a, s) => a + s.length, 0) > MAX_TOTAL_B64) return res.status(413).json({ error: '图片太大，请压缩后再传（总计不超过约 6MB）' });
      if (!cfg().key) return res.status(503).json({ error: '识别服务未配置' });
      const why = gate(req.params.id); if (why) return res.status(429).json({ error: why });
      const clientId = req.params.id; const asOf = asOfFor(clientId, req.body.asOf);
      const job = startJob(clientId, 'extract', async (stage) => {
        stage('正在识别图片并核对漏项');
        const r = await mp.extractMaterial(vision, b64s, asOf, { llm, onStage: stage });
        if (r.failed === b64s.length) throw new Error('图片识别失败，请换更清晰的照片重试');
        const extractionId = rid('ex');
        extractions.set(extractionId, { clientId, extraction: r.extraction, asOf, createdAt: Date.now() });
        return { extractionId, extraction: r.extraction, classification: r.classification, images: r.images, failed: r.failed, timings: r.timings };
      });
      res.status(202).json({ jobId: job.id });
    } catch (err) { res.status(500).json({ error: '提交识别任务失败: ' + err.message }); }
  });

  // 2. 用户核对后 → 生成计划草稿
  app.post('/api/clients/:id/plans/material/generate', async (req, res) => {
    try {
      if (!await needClient(req, res)) return;
      const b = req.body || {}; const ex = extractions.get(String(b.extractionId || ''));
      if (!ex || ex.clientId !== req.params.id) return res.status(410).json({ error: '识别结果已过期或不存在，请重新上传' });
      const d = b.decisions || {}; const ints = (a, max) => Array.isArray(a) ? [...new Set(a.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < max))] : [];
      const e0 = ex.extraction;
      const decisions = {
        removeMedications: ints(d.removeMedications, (e0.discharge_medications || []).length),
        removeRestrictions: ints(d.removeRestrictions, (e0.restrictions || []).length),
        removeFollowUps: ints(d.removeFollowUps, (e0.follow_up || []).length),
        acceptMissed: ints(d.acceptMissed, (e0.pending_user_check || []).length),
        editMedications: (Array.isArray(d.editMedications) ? d.editMedications : []).filter((m) => m && Number.isInteger(m.index) && m.index >= 0 && m.index < (e0.discharge_medications || []).length)
          .map((m) => ({ index: m.index, ...(m.dose !== undefined ? { dose: String(m.dose || '').slice(0, 30) } : {}), ...(m.frequency !== undefined ? { frequency: String(m.frequency || '').slice(0, 30) } : {}) })),
      };
      const why = gate(req.params.id); if (why) return res.status(429).json({ error: why });
      const clientId = req.params.id;
      const job = startJob(clientId, 'generate', async (stage) => {
        stage('正在生成计划并做安全校验（约 30–90 秒）');
        // 删除决定里的下标指向"原始提取"，先应用到 extraction 再生成（confirmExtraction 内部按同一顺序处理）
        const conf = mp.confirmExtraction(e0, decisions);
        const plan = await mp.generateMaterialPlan(conf, ex.asOf || today(), llm);
        if (plan.mode === 'blocked') return { blocked: true, mode: plan.mode, questions: plan.questions, not_done: plan.not_done, disclaimer: plan.disclaimer, meta: plan.meta };
        const prop = mp.planToWikiProposal(plan, conf.extraction);
        const active = await planApi.getActive(clientId);
        const newKeys = new Set(prop.items.map((i) => i.key));
        // 较弱的材料（非出院医嘱 / 一年以上的旧材料）只能"追加"，绝不能顶掉已生效的医嘱计划
        const weak = plan.mode === 'insufficient' || plan.mode === 'historical';
        const remove = (active && !weak) ? active.items.filter((i) => String(i.key).startsWith(mp.MATERIAL_KEY_PREFIX) && !newKeys.has(i.key)).map((i) => i.key) : [];
        await planApi.expireMaterialDrafts(clientId);
        const meta = { kind: 'material', mode: plan.mode, doc_type: plan.meta.doc_type, ref_date: plan.meta.ref_date, age_days: plan.meta.age_days, reason: plan.meta.reason, generated_by: plan.meta.generated_by,
          attempts: plan.meta.attempts, added_by_program: plan.meta.added_by_program, user_edits: conf.userEdits, questions: plan.questions, not_done: plan.not_done, disclaimer: plan.disclaimer, violations: plan.meta.violations_history.length };
        const r = await planApi.createProposal(clientId, { source: prop.items.some((i) => i.source === 'doctor') ? 'doctor' : 'system', proposed_by: '医嘱转译', reason: prop.reason, phase_title: prop.phase_title, primary_goal: prop.primary_goal, items: prop.items, remove, meta });
        if (r.code !== 201) return { unchanged: r.code === 400 && /没有任何差别/.test(r.body.error || ''), error: r.body.error, mode: plan.mode, questions: plan.questions, not_done: plan.not_done, disclaimer: plan.disclaimer };
        extractions.delete(String(b.extractionId));
        return { proposal: r.body, mode: plan.mode, questions: plan.questions, not_done: plan.not_done, disclaimer: plan.disclaimer, meta };
      });
      res.status(202).json({ jobId: job.id });
    } catch (err) { res.status(500).json({ error: '提交生成任务失败: ' + err.message }); }
  });

  // 3. 轮询任务
  app.get('/api/clients/:id/plans/material/jobs/:jobId', (req, res) => {
    const j = jobs.get(req.params.jobId);
    if (!j || j.clientId !== req.params.id) return res.status(404).json({ error: '任务不存在或已过期，请重新开始' });
    res.json({ id: j.id, kind: j.kind, status: j.status, stage: j.stage, result: j.status === 'done' ? j.result : undefined, error: j.status === 'error' ? j.error : undefined, elapsed_ms: Date.now() - j.createdAt });
  });
}

module.exports = { registerMaterialPlan };
