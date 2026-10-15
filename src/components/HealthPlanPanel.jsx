import React, { useState, useEffect, useCallback } from 'react';
import MaterialPlanWizard from './MaterialPlanWizard';

// 健康计划板块（与"客户专属 Wiki 档案"并列）：当前计划 / 待确认提案 / 历史版本
const LINES = [
  { key: 'diet', label: '饮食', icon: '🥗' },
  { key: 'exercise', label: '运动', icon: '🏃' },
  { key: 'monitor', label: '监测', icon: '🩺' },
  { key: 'medication', label: '用药', icon: '💊' },
  { key: 'environment', label: '起居与服务', icon: '🛏️' },
];
const SOURCE_LABEL = { system: '系统基础版', nutritionist: '营养师', doctor: '医生', user: '用户自定', ai: 'AI 建议' };
const SOURCE_COLOR = { system: '#64748b', nutritionist: '#059669', doctor: '#2563eb', user: '#d97706', ai: '#7c3aed' };
const MODE_LABEL = { specific: '较新的出院医嘱', confirm_first: '较旧·需确认是否仍有效', historical: '历史材料·需确认现状', insufficient: '不是出院医嘱·仅就医提示', blocked: '非医疗材料' };

const targetText = (t) => {
  if (!t) return '';
  const u = t.unit || '';
  const per = t.period === 'week' ? '每周' : '每天';
  if (t.comparator === 'gte') return `${per} ≥ ${t.value}${u}`;
  if (t.comparator === 'lte') return `${per} ≤ ${t.value}${u}`;
  if (t.comparator === 'eq') return `${per} ${t.value}${u}`;
  if (t.comparator === 'count_gte') return `${per}至少 ${t.value}${u || '次'}`;
  if (t.comparator === 'between') return `${per} ${t.min}~${t.max}${u}`;
  return '';
};
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');

const SourceTag = ({ s }) => (
  <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, color: '#fff', background: SOURCE_COLOR[s] || '#64748b', marginLeft: 8 }}>
    {SOURCE_LABEL[s] || s}
  </span>
);

const ItemRow = ({ it, mark }) => (
  <div data-testid={`plan-item-${it.key}`} style={{ padding: '8px 12px', borderRadius: 8, background: mark === 'add' ? '#ecfdf5' : mark === 'remove' ? '#fef2f2' : '#f8fafc', marginBottom: 6, border: '1px solid #e2e8f0' }}>
    <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a', textDecoration: mark === 'remove' ? 'line-through' : 'none' }}>
      {it.title}
      {targetText(it.target) && <span style={{ marginLeft: 10, color: '#0369a1', fontWeight: 500 }}>{targetText(it.target)}</span>}
      <SourceTag s={it.source} />
    </div>
    {it.detail && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{it.detail}</div>}
    {it.evidence && <div data-testid={`plan-evidence-${it.key}`} style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>依据原句：「{it.evidence}」{it.origin && it.origin.ref_date ? `（${it.origin.doc_type} ${it.origin.ref_date}）` : ''}</div>}
  </div>
);

const describeChange = (c) => {
  const a = c.after, b = c.before;
  if (c.op === 'add') return { cls: '#059669', text: `新增：${a.title}${targetText(a.target) ? '（' + targetText(a.target) + '）' : ''}` };
  if (c.op === 'remove') return { cls: '#dc2626', text: `移除：${b.title}` };
  const bt = targetText(b.target), at = targetText(a.target);
  const from = bt || b.title, to = at || a.title;
  return { cls: '#d97706', text: `调整：${a.title}　${from} → ${to}` };
};

export default function HealthPlanPanel({ clientId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [viewVer, setViewVer] = useState(null);
  const [verData, setVerData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [wizard, setWizard] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/clients/${clientId}/plans`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '加载失败');
      setData(j); setErr('');
    } catch (e) { setErr(e.message); }
  }, [clientId]);

  useEffect(() => { setData(null); setViewVer(null); setVerData(null); load(); }, [load]);

  useEffect(() => {
    if (viewVer == null) { setVerData(null); return; }
    fetch(`/api/clients/${clientId}/plans/versions/${viewVer}`).then((r) => r.json()).then(setVerData).catch(() => setVerData(null));
  }, [viewVer, clientId]);

  const act = async (pid, kind) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/clients/${clientId}/plans/proposals/${pid}/${kind}`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) alert(j.error || '操作失败');
    } finally { setBusy(false); load(); }
  };

  if (err) return <div style={{ padding: 32, color: '#dc2626' }}>健康计划加载失败：{err}</div>;
  if (!data) return <div style={{ padding: 32, color: '#64748b' }}>加载中…</div>;

  const { active, drafts, history } = data;
  const shown = verData && viewVer != null ? verData : active;

  return (
    <div data-testid="health-plan-panel" style={{ padding: '20px 24px', height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#64748b' }}>档案记录"已经发生的事"，健康计划是"接下来要做的事"：调整须经确认才生效，旧版本保留可查。</div>
        <button className="btn-primary" data-testid="open-material-wizard" style={{ borderRadius: 10, whiteSpace: 'nowrap' }} onClick={() => setWizard(true)}>📄 从医院材料生成计划</button>
      </div>
      {wizard && <MaterialPlanWizard clientId={clientId} onDone={load} onClose={() => { setWizard(false); load(); }} />}

      {drafts.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: '#b45309', marginBottom: 10 }}>⏳ 待确认的调整（{drafts.length}）</h3>
          {drafts.map((d) => (
            <div key={d.id} data-testid="plan-draft" style={{ border: '1.5px dashed #f59e0b', background: '#fffbeb', borderRadius: 12, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
                {d.base_version === 0 ? '首份健康计划' : `基于 v${d.base_version} 的调整`}
                <SourceTag s={d.source} />
                <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 10, fontWeight: 400 }}>{fmtTime(d.created_at)} · 提出人：{d.proposed_by}</span>
              </div>
              <div style={{ fontSize: 13, color: '#475569', margin: '6px 0 10px' }}>原因：{d.reason}</div>
              {d.meta && d.meta.kind === 'material' && (
                <div data-testid="plan-draft-meta" style={{ fontSize: 12, color: '#475569', marginBottom: 8 }}>
                  依据：{d.meta.doc_type}{d.meta.ref_date ? `（${d.meta.ref_date}）` : ''} · 判定：{MODE_LABEL[d.meta.mode] || d.meta.mode} · 用户核对改动 {d.meta.user_edits} 处 · {d.meta.generated_by === 'fallback' ? '机械转述（AI 未通过校验）' : `AI 转述，经校验 ${d.meta.attempts} 次`}
                  {(d.meta.questions || []).length > 0 && <div style={{ color: '#0369a1', marginTop: 4 }}>待向您确认：{d.meta.questions.join('；')}</div>}
                  {(d.meta.not_done || []).length > 0 && <div style={{ color: '#92400e', marginTop: 2 }}>没有做：{d.meta.not_done.join('；')}</div>}
                </div>
              )}
              {d.base_version === 0
                ? <div>{d.meta && d.meta.kind === 'material' ? d.items.map((it) => <ItemRow key={it.key} it={it} />) : <div style={{ fontSize: 13, color: '#334155' }}>包含 {d.items.length} 项计划内容（确认后生效为 v1）</div>}</div>
                : (() => {
                    const adds = d.changes.filter((c) => c.op !== 'remove');
                    const rms = d.changes.filter((c) => c.op === 'remove');
                    return <>
                      {adds.map((c, i) => { const x = describeChange(c); return <div key={'a' + i} style={{ fontSize: 13, color: x.cls, marginBottom: 3 }}>• {x.text}</div>; })}
                      {rms.length > 0 && (rms.length <= 3
                        ? rms.map((c, i) => { const x = describeChange(c); return <div key={'r' + i} style={{ fontSize: 13, color: x.cls, marginBottom: 3 }}>• {x.text}</div>; })
                        : <details style={{ fontSize: 13, color: '#dc2626' }}><summary style={{ cursor: 'pointer' }}>将移除 {rms.length} 项旧条目（点开查看）</summary>{rms.map((c, i) => <div key={i} style={{ marginLeft: 14 }}>• {c.before.title}</div>)}</details>)}
                    </>;
                  })()}
              <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
                <button disabled={busy} data-testid="plan-confirm" className="btn-primary" style={{ borderRadius: 10 }} onClick={() => act(d.id, 'confirm')}>确认生效</button>
                <button disabled={busy} data-testid="plan-reject" className="btn-secondary" style={{ borderRadius: 10 }} onClick={() => act(d.id, 'reject')}>暂不采纳</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section style={{ minWidth: 0 }}>
          {!shown ? (
            <div data-testid="plan-empty" style={{ padding: 40, textAlign: 'center', color: '#94a3b8', border: '1px dashed #cbd5e1', borderRadius: 12 }}>
              暂无生效的健康计划。有人提出计划后，需在这里（或客户端）确认才会生效。
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 14, background: 'linear-gradient(135deg,#f0fdf4,#eff6ff)', border: '1px solid #dbeafe' }}>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <span data-testid="plan-version" style={{ fontSize: 12, padding: '2px 10px', borderRadius: 10, background: viewVer != null ? '#e2e8f0' : '#dcfce7', color: viewVer != null ? '#475569' : '#166534', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    v{shown.version}{viewVer != null && shown.status === 'superseded' ? ' · 已被取代（历史）' : ' · 生效中'}
                  </span>
                  {shown.phase_title && <span style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', lineHeight: 1.4 }}>{shown.phase_title}</span>}
                  {viewVer != null && <button className="btn-secondary" style={{ borderRadius: 10 }} onClick={() => setViewVer(null)}>回到当前</button>}
                </div>
                {shown.primary_goal && <div style={{ fontSize: 14, color: '#334155', marginTop: 8, lineHeight: 1.6 }}>🎯 总目标：{shown.primary_goal}</div>}
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6, lineHeight: 1.5 }}>生效于 {fmtTime(shown.confirmed_at)} · {SOURCE_LABEL[shown.source] || shown.source}</div>
                {shown.reason && <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>{shown.reason}</div>}
              </div>
              {LINES.map((ln) => {
                const its = shown.items.filter((i) => i.line === ln.key);
                if (!its.length) return null;
                return (
                  <div key={ln.key} data-testid={`plan-line-${ln.key}`} style={{ marginBottom: 18 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#334155', marginBottom: 8 }}>{ln.icon} {ln.label} <span style={{ fontSize: 12, fontWeight: 500, color: '#94a3b8' }}>· {its.length} 项</span></div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
                      {its.map((it) => <ItemRow key={it.key} it={it} />)}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </section>

        <aside style={{ order: -1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 6 }}>🕘 历史版本（点击查看旧版）</div>
          {history.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>还没有版本</div>}
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 }}>
            {history.map((h) => {
              const cnt = (op) => (h.changes || []).filter((c) => c.op === op).length;
              const sel = viewVer === h.version || (viewVer == null && h.status === 'active');
              return (
                <button key={h.id} data-testid={`plan-hist-${h.version}`} onClick={() => setViewVer(h.status === 'active' ? null : h.version)}
                  style={{ flex: '0 0 230px', textAlign: 'left', padding: '8px 12px', borderRadius: 10, cursor: 'pointer',
                    border: sel ? '1.5px solid #3b82f6' : '1px solid #e2e8f0', background: sel ? '#eff6ff' : '#fff' }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>v{h.version} <span style={{ fontWeight: 500, color: h.status === 'active' ? '#16a34a' : '#94a3b8' }}>{h.status === 'active' ? '生效中' : '已取代'}</span></div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{SOURCE_LABEL[h.source] || h.source} · {fmtTime(h.confirmed_at)}</div>
                  {h.version > 1 && (h.changes || []).length > 0 && (
                    <div style={{ fontSize: 11, marginTop: 3 }}>
                      <span style={{ color: '#059669' }}>新增 {cnt('add')}</span>　<span style={{ color: '#d97706' }}>调整 {cnt('update')}</span>　<span style={{ color: '#dc2626' }}>移除 {cnt('remove')}</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}
