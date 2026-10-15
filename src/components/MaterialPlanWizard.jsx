import React, { useState, useRef, useEffect } from 'react';
import { filesToImages } from '../lib/materialFiles';

// 「出院材料 → 计划」向导：上传 → 识别 → 用户核对 → 生成草稿（确认生效仍在计划面板里）
// 说明：本系统只"转述医生写在材料里的医嘱"，不诊断；图片只用于识别，不保存。

const MODE_INFO = {
  specific: { color: '#166534', bg: '#dcfce7', title: '出院医嘱（较新）', text: '将逐条转述材料里的医嘱，每条都带原句出处。' },
  confirm_first: { color: '#b45309', bg: '#fef3c7', title: '出院医嘱（有些旧了）', text: '材料已有一段时间，需要先确认医嘱现在是否仍有效，计划里的条目都会标"待确认"。' },
  historical: { color: '#b45309', bg: '#fef3c7', title: '较早的出院材料', text: '材料距今超过一年，只作历史记录；会先向您确认目前情况，不会当作现行医嘱。' },
  insufficient: { color: '#b91c1c', bg: '#fee2e2', title: '不是出院医嘱', text: '这份材料没有医生给的出院指示。系统不会据此生成饮食/运动/用药计划，只给"尽快就医、出现哪些情况立即就诊"的提示。' },
  blocked: { color: '#475569', bg: '#e2e8f0', title: '不是医疗材料', text: '看起来不是医疗材料（费用清单/证件等），不会生成任何计划。' },
};
const LINE_LABEL = { diet: '饮食', exercise: '运动', monitor: '监测', medication: '用药', environment: '起居与就医' };

async function downscale(file, maxEdge = 1600, q = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('无法读取图片')); i.src = url; });
    const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  } finally { URL.revokeObjectURL(url); }
}

async function api(path, opts) {
  const r = await fetch(path, opts); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `请求失败（${r.status}）`);
  return j;
}
async function pollJob(base, jobId, onStage, signal) {
  const t0 = Date.now(); let fails = 0;
  for (;;) {
    if (signal.cancelled) throw new Error('已取消');
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const j = await api(`${base}/material/jobs/${jobId}`); fails = 0;
      onStage(`${j.stage}　已用 ${Math.round((Date.now() - t0) / 1000)} 秒`);
      if (j.status === 'done') return j.result;
      if (j.status === 'error') throw new Error(j.error || '处理失败');
    } catch (e) { if (/任务不存在|处理失败|识别失败/.test(e.message) || ++fails > 5) throw e; }
    if (Date.now() - t0 > 6 * 60 * 1000) throw new Error('处理超时，请稍后重试');
  }
}

const Box = ({ title, children, tid }) => (
  <div data-testid={tid} style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 12, background: '#fff' }}>
    <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a', marginBottom: 8 }}>{title}</div>{children}
  </div>
);

export default function MaterialPlanWizard({ clientId, onDone, onClose }) {
  const base = `/api/clients/${clientId}/plans`;
  const [step, setStep] = useState('pick');
  const [files, setFiles] = useState([]);
  const [stage, setStage] = useState('');
  const [notes, setNotes] = useState([]);
  const [err, setErr] = useState('');
  const [ex, setEx] = useState(null);       // { extractionId, extraction, classification, images, failed }
  const [keepMed, setKeepMed] = useState([]); const [meds, setMeds] = useState([]);
  const [keepRes, setKeepRes] = useState([]); const [keepFu, setKeepFu] = useState([]); const [accept, setAccept] = useState([]);
  const [checked, setChecked] = useState(false);
  const [result, setResult] = useState(null);
  const cancel = useRef({ cancelled: false });
  useEffect(() => () => { cancel.current.cancelled = true; }, []);

  const start = async () => {
    setErr(''); setStep('extracting'); setStage('正在压缩并上传图片…');
    try {
      const { images, notes: ns } = await filesToImages(files); setNotes(ns);
      const { jobId } = await api(`${base}/material/extract`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images, asOf: window.__MATERIAL_TEST_ASOF__ }) });
      const r = await pollJob(base, jobId, setStage, cancel.current);
      setEx(r); const e = r.extraction;
      setMeds((e.discharge_medications || []).map((m) => ({ dose: m.dose || '', frequency: m.frequency || '' })));
      setKeepMed((e.discharge_medications || []).map(() => true)); setKeepRes((e.restrictions || []).map(() => true));
      setKeepFu((e.follow_up || []).map(() => true)); setAccept((e.pending_user_check || []).map(() => false)); setChecked(false);
      setStep('review');
    } catch (e) { setErr(e.message); setStep('pick'); }
  };

  const generate = async () => {
    setErr(''); setStep('generating'); setStage('正在提交…');
    try {
      const e = ex.extraction; const idx = (arr, keep) => arr.map((_, i) => i).filter((i) => !keep[i]);
      const edits = (e.discharge_medications || []).map((m, i) => ({ i, m })).filter(({ i, m }) => keepMed[i] && ((meds[i].dose || '') !== (m.dose || '') || (meds[i].frequency || '') !== (m.frequency || '')))
        .map(({ i }) => ({ index: i, dose: meds[i].dose, frequency: meds[i].frequency }));
      const decisions = { removeMedications: idx(e.discharge_medications || [], keepMed), removeRestrictions: idx(e.restrictions || [], keepRes), removeFollowUps: idx(e.follow_up || [], keepFu), acceptMissed: accept.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), editMedications: edits };
      const { jobId } = await api(`${base}/material/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extractionId: ex.extractionId, decisions }) });
      const r = await pollJob(base, jobId, setStage, cancel.current);
      setResult(r); setStep('done'); if (r.proposal && onDone) onDone();
    } catch (e) { setErr(e.message); setStep('review'); }
  };

  const decide = async (kind) => {
    try { await api(`${base}/proposals/${result.proposal.id}/${kind}`, { method: 'POST' }); if (onDone) onDone(); onClose && onClose(); }
    catch (e) { setErr(e.message); }
  };

  const mode = ex && MODE_INFO[ex.classification.mode];
  const e = ex && ex.extraction;

  return (
    <div data-testid="material-wizard" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 50, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflowY: 'auto', padding: '32px 16px' }}>
      <div style={{ width: 'min(820px,100%)', background: '#f8fafc', borderRadius: 16, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>📄 从医院材料生成计划</div>
          <button className="btn-secondary" data-testid="wizard-close" style={{ borderRadius: 10 }} onClick={() => { cancel.current.cancelled = true; onClose && onClose(); }}>关闭</button>
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>系统只"转述医生写在材料里的医嘱"，不做诊断、不加药、不改剂量；照片仅用于识别，不会保存。所有内容以医生意见为准。</div>
        {err && <div data-testid="wizard-error" style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>⚠️ {err}</div>}

        {step === 'pick' && (
          <div data-testid="wizard-step-pick">
            <input data-testid="wizard-file" type="file" accept="image/*,application/pdf,.pdf" multiple onChange={(ev) => setFiles([...ev.target.files].slice(0, 6))} />
            <div style={{ fontSize: 12, color: '#64748b', margin: '8px 0' }}>支持出院小结 / 出院记录 / 诊断证明 / 检查报告的<b>照片或 PDF</b>（文字版、扫描版都行），一次最多读取 6 张图片/PDF 页（多页请一起选）。</div>
            {files.length > 0 && <div data-testid="wizard-filelist" style={{ fontSize: 13, marginBottom: 8 }}>已选 {files.length} 个文件：{files.map((f) => f.name).join('、')}</div>}
            <button className="btn-primary" data-testid="wizard-start" disabled={!files.length} style={{ borderRadius: 10 }} onClick={start}>开始识别</button>
          </div>
        )}

        {(step === 'extracting' || step === 'generating') && (
          <div data-testid={`wizard-step-${step}`} style={{ padding: 40, textAlign: 'center', color: '#475569' }}>
            <div style={{ fontSize: 28 }}>⏳</div><div data-testid="wizard-stage" style={{ marginTop: 8 }}>{stage}</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>请不要关闭页面。识别和校验需要一点时间。</div>
            {step === 'extracting' && notes.length > 0 && <div data-testid="wizard-notes-live" style={{ fontSize: 12, color: '#b45309', marginTop: 10 }}>{notes.map((n, i) => <div key={i}>ℹ️ {n}</div>)}</div>}
          </div>
        )}

        {step === 'review' && ex && (
          <div data-testid="wizard-step-review">
            <div data-testid="wizard-mode" style={{ background: mode.bg, color: mode.color, borderRadius: 12, padding: '10px 14px', marginBottom: 12 }}>
              <div style={{ fontWeight: 800 }}>系统判定：{mode.title}</div>
              <div style={{ fontSize: 13, marginTop: 2 }}>{mode.text}</div>
              <div style={{ fontSize: 12, marginTop: 4, opacity: .85 }}>依据：{ex.classification.reason}</div>
            </div>
            {notes.length > 0 && <div data-testid="wizard-notes" style={{ fontSize: 12, color: '#b45309', marginBottom: 8 }}>{notes.map((n, i) => <div key={i}>ℹ️ {n}</div>)}</div>}
            {ex.failed > 0 && <div style={{ fontSize: 12, color: '#b45309', marginBottom: 8 }}>有 {ex.failed} 张图片没有识别成功，没读到的内容不会进入计划。可以关闭后换更清晰的照片重试。</div>}
            <Box title={`材料信息：${e.doc_type || '未识别'}`} tid="wizard-docinfo">
              <div style={{ fontSize: 13, color: '#475569' }}>入院 {e.admit_date || '—'} ｜ 出院 {e.discharge_date || '—'} ｜ 文书日期 {e.doc_date || '—'}　　共 {ex.images.length} 张</div>
            </Box>
            {(e.diagnoses || []).length > 0 && <Box title="材料上写的诊断（原文记录，不是本系统的诊断）" tid="wizard-diag">{e.diagnoses.map((d, i) => <div key={i} style={{ fontSize: 13 }}>• {d.text}</div>)}</Box>}
            {(e.discharge_medications || []).length > 0 && (
              <Box title="出院带药（请对照药盒/处方核对，可修改剂量或取消）" tid="wizard-meds">
                {e.discharge_medications.map((m, i) => (
                  <div key={i} data-testid={`wizard-med-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 260, fontSize: 13, fontWeight: 600 }}><input type="checkbox" data-testid={`wizard-med-keep-${i}`} checked={!!keepMed[i]} onChange={() => setKeepMed(keepMed.map((v, j) => (j === i ? !v : v)))} />{m.name}</label>
                    <input data-testid={`wizard-med-dose-${i}`} disabled={!keepMed[i]} value={meds[i].dose} placeholder="剂量" style={{ width: 110 }} onChange={(ev) => setMeds(meds.map((v, j) => (j === i ? { ...v, dose: ev.target.value } : v)))} />
                    <input data-testid={`wizard-med-freq-${i}`} disabled={!keepMed[i]} value={meds[i].frequency} placeholder="频次" style={{ width: 110 }} onChange={(ev) => setMeds(meds.map((v, j) => (j === i ? { ...v, frequency: ev.target.value } : v)))} />
                  </div>
                ))}
              </Box>
            )}
            {(e.restrictions || []).length > 0 && <Box title="注意事项 / 限制" tid="wizard-restr">{e.restrictions.map((r, i) => <label key={i} style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 4 }}><input type="checkbox" data-testid={`wizard-res-keep-${i}`} checked={!!keepRes[i]} onChange={() => setKeepRes(keepRes.map((v, j) => (j === i ? !v : v)))} />{r.text}{r.duration ? `（${r.duration}）` : ''}</label>)}</Box>}
            {(e.follow_up || []).length > 0 && <Box title="复诊 / 复查安排" tid="wizard-fu">{e.follow_up.map((f, i) => <label key={i} style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 4 }}><input type="checkbox" data-testid={`wizard-fu-keep-${i}`} checked={!!keepFu[i]} onChange={() => setKeepFu(keepFu.map((v, j) => (j === i ? !v : v)))} />{f.when} {f.what}</label>)}</Box>}
            {((e.monitoring || []).length > 0 || (e.return_signs || []).length > 0) && <Box title="监测与需要就医的情况" tid="wizard-mon">{[...(e.monitoring || []), ...(e.return_signs || [])].map((t, i) => <div key={i} style={{ fontSize: 13 }}>• {t}</div>)}</Box>}
            {(e.pending_user_check || []).length > 0 && (
              <Box title="第二遍核对时发现，图片上似乎还有这些（勾选才会加入；可能与上面重复）" tid="wizard-missed">
                {e.pending_user_check.map((p, i) => <label key={i} style={{ display: 'flex', gap: 6, fontSize: 13, marginBottom: 4 }}><input type="checkbox" data-testid={`wizard-missed-${i}`} checked={!!accept[i]} onChange={() => setAccept(accept.map((v, j) => (j === i ? !v : v)))} /><span>{p.text}{p.quote ? <span style={{ color: '#94a3b8' }}>　原句：{p.quote}</span> : null}</span></label>)}
              </Box>
            )}
            <label style={{ display: 'flex', gap: 8, fontSize: 13, margin: '12px 0' }}><input type="checkbox" data-testid="wizard-confirm-check" checked={checked} onChange={() => setChecked(!checked)} />我已对照原件核对以上内容，同意据此生成计划草稿</label>
            <button className="btn-primary" data-testid="wizard-generate" disabled={!checked} style={{ borderRadius: 10 }} onClick={generate}>生成计划草稿</button>
          </div>
        )}

        {step === 'done' && result && (
          <div data-testid="wizard-step-done">
            {result.blocked ? (
              <Box title="没有生成计划" tid="wizard-blocked">{(result.not_done || []).map((t, i) => <div key={i} style={{ fontSize: 13 }}>• {t}</div>)}{(result.questions || []).map((q, i) => <div key={i} style={{ fontSize: 13, color: '#0369a1' }}>→ {q}</div>)}</Box>
            ) : result.unchanged ? (
              <Box title="与当前计划没有区别" tid="wizard-unchanged"><div style={{ fontSize: 13 }}>这份材料生成的内容和现有计划一致，无需调整。</div></Box>
            ) : result.proposal ? (
              <>
                <div data-testid="wizard-result-title" style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>{result.proposal.phase_title}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>{result.disclaimer}　{result.meta && result.meta.generated_by === 'fallback' ? '（AI 未通过安全校验，已按材料原文机械转述）' : ''}</div>
                {(() => { const ch = result.proposal.changes || []; const rm = ch.filter((c) => c.op === 'remove'); return rm.length ? <Box title="确认后将被这份材料取代的旧条目" tid="wizard-removed">{rm.map((c) => <div key={c.key} style={{ fontSize: 12, color: '#b91c1c' }}>• {c.before && c.before.title}</div>)}</Box> : null; })()}
                {Object.keys(LINE_LABEL).map((ln) => { const ch = result.proposal.changes || []; const shown = ch.length ? ch.filter((c) => c.op !== 'remove').map((c) => c.after) : result.proposal.items; const its = shown.filter((i) => i.line === ln); if (!its.length) return null;
                  return <Box key={ln} title={LINE_LABEL[ln]} tid={`wizard-line-${ln}`}>{its.map((i) => (
                    <div key={i.key} data-testid={`wizard-item-${i.key}`} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{i.title}</div><div style={{ fontSize: 12, color: '#475569' }}>{i.detail}</div>
                      {i.evidence && <div style={{ fontSize: 11, color: '#94a3b8' }}>依据原句：「{i.evidence}」{i.origin && i.origin.ref_date ? `（${i.origin.doc_type} ${i.origin.ref_date}）` : ''}</div>}
                    </div>))}</Box>; })}
                {(result.questions || []).length > 0 && <Box title="还需要向您确认的问题" tid="wizard-questions">{result.questions.map((q, i) => <div key={i} style={{ fontSize: 13 }}>• {q}</div>)}</Box>}
                {(result.not_done || []).length > 0 && <Box title="没有做的事（以及原因）" tid="wizard-notdone">{result.not_done.map((q, i) => <div key={i} style={{ fontSize: 13, color: '#92400e' }}>• {q}</div>)}</Box>}
                <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                  <button className="btn-primary" data-testid="wizard-confirm-plan" style={{ borderRadius: 10 }} onClick={() => decide('confirm')}>确认生效</button>
                  <button className="btn-secondary" data-testid="wizard-reject-plan" style={{ borderRadius: 10 }} onClick={() => decide('reject')}>暂不采纳</button>
                  <span style={{ fontSize: 12, color: '#94a3b8', alignSelf: 'center' }}>也可以稍后在"健康计划"里确认（草稿保留 7 天）</span>
                </div>
              </>
            ) : <div style={{ fontSize: 13 }}>没有生成内容{result.error ? `：${result.error}` : ''}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
