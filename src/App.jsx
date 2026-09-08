import React, { useState, useEffect, useMemo } from 'react';
import HealthWikiRenderer from './components/HealthWikiRenderer';
import AnatomicalHealthMap from './components/AnatomicalHealthMap';

// ── 预置示例模板 ──
const SAMPLE_TEMPLATES = {
  phone: {
    title: '5月21日 电话问诊记录',
    content: `[患者] 医生你好，我最近三天感觉后脑勺胀痛，特别是早上起床的时候明显，伴有轻微耳鸣，人有点飘。
[医生] 你好，家里有血压计吗？今天量过血压没有？
[患者] 量了，今天早上量的是158/98。
[医生] 血压明显偏高了。你之前有高血压病史吗？平时吃什么药？
[患者] 有高血压五年了，之前医生开了“氨氯地平片”，但我最近大半个月觉得血压挺正常，就自己把药停了。
[医生] 这是非常危险的行为，降压药绝对不能自行停药。你今天立刻恢复服用“苯磺酸氨氯地平片”，每天早上吃一片（5mg）。同时，这一周要每天早晚各量一次血压并记录。饮食上要严格低盐，少吃咸菜和腌制品。如果过两天血压降不下来，或者头晕加重、出现视物模糊，必须立刻去医院挂急诊。`
  },
  wechat: {
    title: '企微随访沟通记录',
    content: `患者 10:15 : 医生，我按照你说的把“氨氯地平”吃回去了，今天早上量的血压是 136/86，头晕脑胀的感觉好多了，就是感觉有点口干，脚踝好像有一点点肿。
健康管理师 10:17 : 血压下来了是个好现象。苯磺酸氨氯地平可能会引起轻微的下肢水肿（特别是脚踝）和口干，这是常见的副作用。建议你平时多喝水，睡觉时可以用枕头稍微把脚垫高。
患者 10:19 : 好的，那这药还要继续吃吗？
健康管理师 10:20 : 要继续吃，千万不能再停。我会把脚踝轻度水肿和口干的情况记录在你的 Wiki 档案中。如果水肿加重或者出现心慌，请及时联系我们。下周三记得准时复诊。`
  },
  ocr: {
    title: '生化化验单 OCR 识别',
    content: `报告名称：心血管及血脂生化检查单
检测医院：人民第一医院
报告日期：2026-05-20
检测指标：
- 甘油三酯 (TG): 2.65 mmol/L ↑ (参考范围: 0.56 - 1.70)
- 总胆固醇 (TC): 6.12 mmol/L ↑ (参考范围: 3.10 - 5.18)
- 低密度脂蛋白 (LDL-C): 4.15 mmol/L ↑ (参考范围: 2.07 - 3.12)
- 空腹血糖 (GLU): 5.4 mmol/L (参考范围: 3.9 - 6.1)
诊断结论：混合型高脂血症，建议清淡饮食，加强有氧运动，并在两周后复查血脂。`
  }
};

const getPageDisplayName = (filename) => {
  switch (filename) {
    case 'index.md': return '📋 客户健康首页';
    case 'medical_history.md': return '🧬 既往史时间轴';
    case 'medication_plan.md': return '💊 用药方案与医嘱';
    case 'communication_timeline.md': return '📅 随访与原始证据';
    default: return filename;
  }
};

// ── 动态生命体征提取模型 ──
function extractVitalSigns(wikiPages) {
  let spo2 = { value: '—', unit: '%', status: '未记录', className: 'normal' };
  let bp = { value: '—', unit: 'mmHg', status: '未记录', className: 'normal' };
  let bg = { value: '—', unit: 'mmol/L', status: '未记录', className: 'normal' };
  let temp = { value: '—', unit: '℃', status: '未记录', className: 'normal' };
  let resp = { value: '—', unit: '次/分', status: '未记录', className: 'normal' };

  const allContent = Object.values(wikiPages).join('\n');

  // 1. SpO2
  const spo2Matches = [...allContent.matchAll(/(?:血氧|spo2|SpO2)\D{0,12}?(\d{2,3})\s*%/gi)];
  const spo2Vals = spo2Matches.map(m => parseInt(m[1])).filter(v => v >= 70 && v <= 100);
  if (spo2Vals.length > 0) {
    const latest = spo2Vals[spo2Vals.length - 1];
    spo2.value = `${latest}%`;
    if (latest < 90) { spo2.status = '高危'; spo2.className = 'danger'; }
    else if (latest < 95) { spo2.status = '偏低'; spo2.className = 'warning'; }
  }

  // 2. 血糖
  const bgMatches = [...allContent.matchAll(/(?:血糖|glucose|指尖血糖)\D{0,12}?(\d+(?:\.\d+)?)\s*mmol/gi)];
  const bgVals = bgMatches.map(m => parseFloat(m[1])).filter(v => v >= 2.0 && v <= 35.0);
  if (bgVals.length > 0) {
    const latest = bgVals[bgVals.length - 1];
    bg.value = latest.toString();
    if (latest >= 10.0 || latest < 3.9) { bg.status = '高危'; bg.className = 'danger'; }
    else if (latest >= 7.0) { bg.status = '异常'; bg.className = 'warning'; }
  }

  // 3. 呼吸频率
  const respMatch = allContent.match(/(?:呼吸)\D{0,8}?(\d{1,2})\s*次/);
  if (respMatch) {
    const val = parseInt(respMatch[1]);
    resp.value = val.toString();
    if (val >= 22) { resp.status = '气促'; resp.className = 'warning'; }
  }

  // 4. 血压
  const bpMatches = [...allContent.matchAll(/(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:mmHg|mm\s*Hg)/gi)];
  const bpVals = bpMatches.map(m => ({ sys: parseInt(m[1]), dia: parseInt(m[2]) }))
    .filter(v => v.sys >= 60 && v.sys <= 260 && v.dia >= 30 && v.dia <= 160);
  if (bpVals.length > 0) {
    const latest = bpVals[bpVals.length - 1];
    bp.value = `${latest.sys}/${latest.dia}`;
    if (latest.sys >= 140 || latest.dia >= 90) { bp.className = 'warning'; }
  }

  // 5. 体温
  const tempMatches = [...allContent.matchAll(/(?:体温)\s*[\s：:]?\s*(\d{2}(?:\.\d+)?)\s*[℃°C]/gi)];
  const tempVals = tempMatches.map(m => parseFloat(m[1])).filter(v => v >= 35.0 && v <= 42.0);
  if (tempVals.length > 0) {
    const latest = tempVals[tempVals.length - 1];
    temp.value = `${latest}℃`;
    if (latest >= 37.3) { temp.className = 'warning'; }
  }

  return { spo2, bp, bg, temp, resp };
}

export default function App() {
  // ── 状态管理 ──
  const [clients, setClients] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [selectedClient, setSelectedClient] = useState(null);
  const [wikiPages, setWikiPages] = useState({});
  const [activeWikiPage, setActiveWikiPage] = useState('index.md');
  const [logs, setLogs] = useState([]);
  const [selectedOrgan, setSelectedOrgan] = useState('lung');

  // 弹窗与表单状态
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [newClientData, setNewClientData] = useState({ name: '', age: '', gender: '男', phone: '', allergies: '' });
  const [editClientData, setEditClientData] = useState({ name: '', age: '', gender: '男', phone: '', allergies: '' });

  const [showLogModal, setShowLogModal] = useState(false);
  const [newLogData, setNewLogData] = useState({ type: 'phone', title: '', content: '' });

  // 状态标记
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [alert, setAlert] = useState(null);
  const [prevWikiPages, setPrevWikiPages] = useState({});
  const [showDiff, setShowDiff] = useState(false);

  // 溯源抽屉状态
  const [selectedLogForTrace, setSelectedLogForTrace] = useState(null);
  const [tracePanelOpen, setTracePanelOpen] = useState(false);

  // 提示 Toast 助手
  const showToast = (message, type = 'info') => {
    setAlert({ message, type });
    setTimeout(() => setAlert(null), 3500);
  };

  // 提取生命体征
  const vitals = useMemo(() => {
    return extractVitalSigns(wikiPages);
  }, [wikiPages]);

  // ── 初始化与客户端切换 ──
  useEffect(() => {
    fetchClients();
  }, []);

  useEffect(() => {
    if (selectedClientId) {
      fetchClientDetails(selectedClientId);
    } else {
      setSelectedClient(null);
      setWikiPages({});
      setLogs([]);
    }
  }, [selectedClientId]);

  // ── API 请求方法 ──
  const DEFAULT_CLIENTS = [
    {
      id: "case_combined_elderly",
      name: "案例一：老年慢阻肺合并脊柱骨折与糖尿病照护",
      age: 73,
      gender: "男",
      phone: "130-0000-0001",
      allergies: "无已知药物过敏，暂行术前禁食水"
    },
    {
      id: "case_combined_crohn_wearable",
      name: "案例二：克罗恩病青年维持期及穿戴生理指标监测",
      age: 26,
      gender: "男",
      phone: "130-0000-0002",
      allergies: "无已知药物过敏，既往IT痰史"
    },
    {
      id: "case_combined_stroke_multichannel",
      name: "案例三：重度高血压脑出血ICU急救与急诊多渠道回溯",
      age: 53,
      gender: "男",
      phone: "130-0000-0003",
      allergies: "无已知药物过敏，有断药史"
    },
    {
      id: "case_combined_pediatric",
      name: "案例四：儿童骑车摔伤与退热后手脚黄染分诊",
      age: 8,
      gender: "男",
      phone: "130-0000-0004",
      allergies: "无已知药物过敏"
    }
  ];

  const fetchClients = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/clients');
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        setClients(data);
        if (!selectedClientId) {
          setSelectedClientId(data[0].id);
        }
        return;
      }
      // 如果后端连接超时或返回非数组，平滑使用真实默认客户库
      setClients(DEFAULT_CLIENTS);
      if (!selectedClientId) setSelectedClientId(DEFAULT_CLIENTS[0].id);
    } catch (err) {
      setClients(DEFAULT_CLIENTS);
      if (!selectedClientId) setSelectedClientId(DEFAULT_CLIENTS[0].id);
    } finally {
      setLoading(false);
    }
  };

  const fetchClientDetails = async (clientId) => {
    try {
      const clientRes = await fetch('/api/clients');
      const clientsList = await clientRes.json();
      const current = Array.isArray(clientsList) 
        ? clientsList.find(c => c.id === clientId)
        : DEFAULT_CLIENTS.find(c => c.id === clientId);
      setSelectedClient(current || DEFAULT_CLIENTS[0]);

      const wikiRes = await fetch(`/api/clients/${clientId}/wiki`);
      const wikiData = await wikiRes.json();
      if (wikiData && typeof wikiData === 'object' && !wikiData.error) {
        setWikiPages(wikiData);
        if (!wikiData[activeWikiPage]) {
          const availablePages = Object.keys(wikiData);
          if (availablePages.length > 0) {
            setActiveWikiPage(availablePages[0]);
          }
        }
      }

      const logsRes = await fetch(`/api/clients/${clientId}/logs`);
      const logsData = await logsRes.json();
      if (Array.isArray(logsData)) {
        setLogs(logsData);
      }
    } catch (err) {
      console.warn('Using client details fallback');
      const current = DEFAULT_CLIENTS.find(c => c.id === clientId) || DEFAULT_CLIENTS[0];
      setSelectedClient(current);
    }
  };

  const handleCreateClient = async (e) => {
    e.preventDefault();
    if (!newClientData.name) return;
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newClientData)
      });
      const data = await res.json();
      showToast(`客户 ${data.name} 创建成功并初始化健康Wiki！`, 'success');
      setShowAddModal(false);
      setNewClientData({ name: '', age: '', gender: '男', phone: '', allergies: '' });
      await fetchClients();
      setSelectedClientId(data.id);
    } catch (err) {
      showToast('创建客户失败', 'error');
    }
  };

  const handleUpdateClient = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/clients/${selectedClientId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editClientData)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');
      showToast('客户基本信息已更新', 'success');
      setShowEditModal(false);
      setSelectedClient(data);
      fetchClients();
    } catch (err) {
      showToast(`更新客户信息失败: ${err.message}`, 'error');
    }
  };

  const handleAddLog = async (e) => {
    e.preventDefault();
    if (!newLogData.content) return;
    try {
      await fetch(`/api/clients/${selectedClientId}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLogData)
      });
      showToast('原始沟通记录录入成功', 'success');
      setShowLogModal(false);
      setNewLogData({ type: 'phone', title: '', content: '' });
      fetchClientDetails(selectedClientId);
    } catch (err) {
      showToast('录入沟通记录失败', 'error');
    }
  };

  const handleLlmSync = async () => {
    try {
      setSyncing(true);
      setPrevWikiPages({ ...wikiPages });
      setShowDiff(true);
      showToast('🚀 已启动 AI 增量建库同步管线...', 'info');
      const res = await fetch(`/api/clients/${selectedClientId}/sync`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        if (data.wikiUpdated) {
          showToast(`✅ 大模型同步完成！已重构 Wiki: ${data.updatedFiles.join(', ')}`, 'success');
        } else {
          showToast(data.message || '没有检测到需要同步的新记录', 'info');
          setShowDiff(false);
        }
        fetchClientDetails(selectedClientId);
      } else {
        showToast(data.error || '同步失败', 'error');
        setShowDiff(false);
      }
    } catch (err) {
      showToast('同步网络错误，请检查后端或大模型API Key', 'error');
      setShowDiff(false);
    } finally {
      setSyncing(false);
    }
  };

  const handleOpenReference = (logId) => {
    const foundLog = logs.find(l => l.id === logId || l.id.includes(logId) || logId.includes(l.id));
    if (foundLog) {
      setSelectedLogForTrace(foundLog);
      setTracePanelOpen(true);
    } else {
      showToast(`未能查找到 ID 为 ${logId} 的原始记录`, 'error');
    }
  };

  const handleSelectionAction = async (action, text) => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          text,
          context: `患者姓名: ${selectedClient?.name || '未知'}, 年龄: ${selectedClient?.age || '未知'}, 性别: ${selectedClient?.gender || '未知'}, 过敏史: ${selectedClient?.allergies || '无'}`
        })
      });
      return await res.json();
    } catch (err) {
      return { answer: 'AI 分析服务暂时不可用' };
    }
  };

  const handleSelectOrgan = (organId) => {
    setSelectedOrgan(organId);
    // 切换到综合首页并寻找匹配段落滚动
    setActiveWikiPage('index.md');
    setTimeout(() => {
      const targetElement = document.querySelector(`[data-organ="${organId}"]`) || document.querySelector('.clinical-fact-item');
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  };

  return (
    <div className="cockpit-layout-root">
      {/* Toast 提示 */}
      {alert && (
        <div style={{
          position: 'fixed',
          top: '20px',
          right: '24px',
          zIndex: 9999,
          background: alert.type === 'error' ? '#fee2e2' : alert.type === 'success' ? '#dcfce7' : '#e0f2fe',
          color: alert.type === 'error' ? '#e11d48' : alert.type === 'success' ? '#15803d' : '#0369a1',
          padding: '10px 18px',
          borderRadius: '12px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
          fontWeight: '700',
          fontSize: '13px',
          border: '1px solid rgba(0,0,0,0.06)'
        }}>
          {alert.message}
        </div>
      )}

      {/* ── 左侧仿生客户档案库侧栏 ── */}
      <aside className="bionic-sidebar">
        <div className="brand-pill">
          <div className="brand-icon">
            <span className="material-symbols-outlined">vital_signs</span>
          </div>
          <div>
            <div className="brand-title">LLMWiki 仿生视界</div>
            <div style={{ display: 'flex', gap: '4px', marginTop: '2px' }}>
              <span className="brand-badge">双翼驾驶舱 · 正式系统</span>
            </div>
          </div>
        </div>

        <div className="sidebar-roster-title">客户健康档案库 ({clients.length})</div>

        <div className="sidebar-roster">
          {clients.map(client => {
            const isSelected = client.id === selectedClientId;
            return (
              <div
                key={client.id}
                className={`roster-item ${isSelected ? 'active' : ''}`}
                onClick={() => setSelectedClientId(client.id)}
              >
                <div className="roster-name">
                  <span>{client.name.split('：')[1] || client.name}</span>
                  {client.age && <span className="roster-tag-danger">{client.age}岁</span>}
                </div>
                <div className="roster-sub">
                  {client.allergies ? client.allergies.slice(0, 22) : '暂无过敏记录'}
                </div>
              </div>
            );
          })}
        </div>

        <button
          className="sidebar-footer-btn"
          onClick={() => setShowAddModal(true)}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>person_add</span>
          <span>新建客户健康档案</span>
        </button>
      </aside>

      {/* ── 主画布区域 ── */}
      <main className="cockpit-main">
        {selectedClient ? (
          <>
            {/* 顶部患者全景视界卡 (真实数据监护名片) */}
            <header className="horizon-patient-header">
              <div className="patient-intro">
                <div className="patient-avatar-bionic">
                  {selectedClient.name.charAt(0) || '患'}
                </div>
                <div className="patient-title-group">
                  <h1>
                    <span>{selectedClient.name}</span>
                    <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-muted)', background: '#f1f5f9', padding: '2px 8px', borderRadius: '6px' }}>
                      {selectedClient.gender || '未知'} · {selectedClient.age || '—'}岁
                    </span>
                    <span className="pill-badge danger">一级特级护理</span>
                    <span className="pill-badge amber">防跌倒高危</span>
                    <span className="pill-badge teal">Braden 11分受控</span>
                  </h1>
                  <div className="patient-tags-line">
                    <span>📞 {selectedClient.phone || '130-0000-0001'}</span>
                    <span>·</span>
                    <span>🏥 骨科脊柱病区一组 18床 (ZH0058921)</span>
                    <span>·</span>
                    <span style={{ color: '#e11d48', fontWeight: '600' }}>
                      ⚠️ {selectedClient.allergies || '无已知药物过敏'}
                    </span>
                  </div>
                </div>
              </div>

              {/* 遥测体征胶囊与同步按钮 */}
              <div className="header-right-group">
                <div className="vitals-horizon-row">
                  <div className="vital-horizon-pill">
                    <span className="material-symbols-outlined" style={{ color: '#f43f5e', fontSize: '18px' }}>air</span>
                    <div>
                      <div className={`vital-horizon-val ${vitals.spo2.className}`}>{vitals.spo2.value}</div>
                      <div className="vital-horizon-meta">血氧 (吸氧2L)</div>
                    </div>
                  </div>

                  <div className="vital-horizon-pill">
                    <span className="material-symbols-outlined" style={{ color: '#f59e0b', fontSize: '18px' }}>water_drop</span>
                    <div>
                      <div className={`vital-horizon-val ${vitals.bg.className}`}>{vitals.bg.value}</div>
                      <div className="vital-horizon-meta">指血 mmol/L</div>
                    </div>
                  </div>

                  <div className="vital-horizon-pill">
                    <span className="material-symbols-outlined" style={{ color: '#d97706', fontSize: '18px' }}>lungs</span>
                    <div>
                      <div className={`vital-horizon-val ${vitals.resp.className}`}>{vitals.resp.value}</div>
                      <div className="vital-horizon-meta">呼吸 次/分</div>
                    </div>
                  </div>

                  <div className="vital-horizon-pill">
                    <span className="material-symbols-outlined" style={{ color: '#0d9488', fontSize: '18px' }}>favorite</span>
                    <div>
                      <div className="vital-horizon-val">{vitals.bp.value}</div>
                      <div className="vital-horizon-meta">血压 · {vitals.temp.value}</div>
                    </div>
                  </div>
                </div>

                <button
                  className="btn-action-sync"
                  onClick={handleLlmSync}
                  disabled={syncing}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px', animation: syncing ? 'spin 1s linear infinite' : 'none' }}>sync</span>
                  <span>{syncing ? '同步中...' : '同步 Wiki'}</span>
                </button>

                <button
                  style={{
                    padding: '8px 12px',
                    borderRadius: '12px',
                    border: '1px solid #e2e8f0',
                    background: '#ffffff',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    color: '#334155',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                  onClick={() => setShowLogModal(true)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px', color: '#0d9488' }}>add_circle</span>
                  <span>录入沟通记录</span>
                </button>
              </div>
            </header>

            {/* 双翼驾驶舱核心网格 (左：人体透视投影台，右：Wiki 核心工作台) */}
            <div className="dual-wing-grid">
              {/* 左翼：高保真人体解剖透视图 */}
              <AnatomicalHealthMap
                markdownContent={wikiPages[activeWikiPage] || Object.values(wikiPages).join('\n')}
                selectedOrgan={selectedOrgan}
                onSelectOrgan={handleSelectOrgan}
              />

              {/* 右翼：医学百科与临床决策工作台 */}
              <article className="wiki-living-sheet">
                <div className="sheet-nav-bar">
                  <div className="sheet-title">
                    <span className="material-symbols-outlined" style={{ color: 'var(--teal-primary)' }}>menu_book</span>
                    <span>{getPageDisplayName(activeWikiPage)}</span>
                  </div>

                  <div className="sheet-tab-pills">
                    {['index.md', 'medical_history.md', 'medication_plan.md', 'communication_timeline.md'].map(page => (
                      <button
                        key={page}
                        className={`sheet-tab-btn ${activeWikiPage === page ? 'active' : ''}`}
                        onClick={() => setActiveWikiPage(page)}
                      >
                        {getPageDisplayName(page)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* AI 临床核心矛盾策展盒 (仅在首页展示) */}
                {activeWikiPage === 'index.md' && (
                  <div className="ai-curated-contradiction">
                    <div className="curated-title">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>psychology</span>
                        AI 临床核心协同矛盾决策 (两难协调规范)
                      </div>
                      <span style={{ fontSize: '11px', background: '#ffffff', color: '#0f766e', padding: '2px 8px', borderRadius: '12px', fontWeight: '700' }}>两难协调</span>
                    </div>
                    <div className="curated-p">
                      患者因慢阻肺咳嗽剧烈导致重心不稳摔伤造成 L2 腰椎骨折。<strong>最关键冲突点在于：慢阻肺剧烈咳嗽引起的胸腹腔高压动荡，会直接造成腰椎骨折断端移位</strong>；但骨折要求绝对制动卧床，又严重阻碍排痰导致坠积性肺炎。临床决策需优先保障镇咳与轻柔双手护腰辅助轴线翻身。
                    </div>
                  </div>
                )}

                {/* Markdown 渲染流 */}
                <div style={{ flex: 1, minHeight: 0 }}>
                  <HealthWikiRenderer
                    markdownContent={wikiPages[activeWikiPage]}
                    prevMarkdownContent={prevWikiPages[activeWikiPage]}
                    showDiff={showDiff}
                    logSources={logs}
                    personMeta={selectedClient}
                    onOpenReference={handleOpenReference}
                    onSelectionAction={handleSelectionAction}
                    isIndexPage={activeWikiPage === 'index.md'}
                  />
                </div>
              </article>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <div style={{ textAlign: 'center', background: '#ffffff', padding: '36px', borderRadius: '24px', boxShadow: 'var(--card-shadow)' }}>
              <h2>请选择或创建一位客户的健康 Wiki</h2>
              <button
                className="btn-action-sync"
                style={{ margin: '16px auto 0 auto' }}
                onClick={() => setShowAddModal(true)}
              >
                立即创建客户
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ── 原始证据侧拉抽屉 ── */}
      <div className={`evidence-drawer-overlay ${tracePanelOpen ? 'open' : ''}`}>
        <div className="drawer-header">
          <div style={{ fontSize: '15px', fontWeight: '800', color: '#0f172a' }}>
            原始溯源证据详实记录
          </div>
          <button className="btn-close-drawer" onClick={() => setTracePanelOpen(false)}>✕</button>
        </div>

        {selectedLogForTrace ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto' }}>
            <div style={{ background: '#f8fafc', padding: '12px 14px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '13px', fontWeight: '800', color: '#0f172a', marginBottom: '4px' }}>
                {selectedLogForTrace.title || '无标题记录'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                <span>ID: {selectedLogForTrace.id}</span> · <span>类型: {selectedLogForTrace.type}</span> · <span>时间: {new Date(selectedLogForTrace.timestamp).toLocaleString()}</span>
              </div>
            </div>

            <div style={{ fontSize: '12px', fontWeight: '700', color: 'var(--text-muted)' }}>原始文字/转录原文：</div>
            <div style={{ background: '#ffffff', padding: '16px', borderRadius: '14px', border: '1px solid #ccfbf1', borderLeft: '4px solid #0d9488', fontSize: '13px', lineHeight: '1.7', color: '#334155', whiteSpace: 'pre-wrap' }}>
              {selectedLogForTrace.content}
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)' }}>暂未选中任何原始记录。</div>
        )}
      </div>

      {/* ── 弹窗 1: 新建客户 ── */}
      {showAddModal && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#ffffff', borderRadius: '20px', padding: '26px', width: '440px', boxShadow: '0 20px 40px rgba(0,0,0,0.15)' }}>
            <h3 style={{ marginBottom: '16px', fontSize: '16px', fontWeight: '800' }}>新建客户健康档案</h3>
            <form onSubmit={handleCreateClient}>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: '700', display: 'block', marginBottom: '4px' }}>姓名 *</label>
                <input
                  type="text"
                  required
                  style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                  placeholder="请输入姓名"
                  value={newClientData.name}
                  onChange={e => setNewClientData({ ...newClientData, name: e.target.value })}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: '700', display: 'block', marginBottom: '4px' }}>年龄</label>
                  <input
                    type="number"
                    style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                    value={newClientData.age}
                    onChange={e => setNewClientData({ ...newClientData, age: e.target.value })}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: '700', display: 'block', marginBottom: '4px' }}>性别</label>
                  <select
                    style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                    value={newClientData.gender}
                    onChange={e => setNewClientData({ ...newClientData, gender: e.target.value })}
                  >
                    <option value="男">男</option>
                    <option value="女">女</option>
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: '700', display: 'block', marginBottom: '4px' }}>联系电话</label>
                <input
                  type="text"
                  style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                  value={newClientData.phone}
                  onChange={e => setNewClientData({ ...newClientData, phone: e.target.value })}
                />
              </div>
              <div style={{ marginBottom: '18px' }}>
                <label style={{ fontSize: '12px', fontWeight: '700', display: 'block', marginBottom: '4px' }}>已知过敏史与警示</label>
                <input
                  type="text"
                  style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                  value={newClientData.allergies}
                  onChange={e => setNewClientData({ ...newClientData, allergies: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button type="button" onClick={() => setShowAddModal(false)} style={{ padding: '8px 16px', borderRadius: '10px', border: '1px solid #e2e8f0', background: '#f8fafc', fontWeight: '700', cursor: 'pointer' }}>取消</button>
                <button type="submit" className="btn-action-sync">创建客户</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── 弹窗 2: 录入新沟通记录 ── */}
      {showLogModal && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#ffffff', borderRadius: '20px', padding: '26px', width: '500px', boxShadow: '0 20px 40px rgba(0,0,0,0.15)' }}>
            <h3 style={{ marginBottom: '16px', fontSize: '16px', fontWeight: '800' }}>录入原始沟通记录</h3>
            <form onSubmit={handleAddLog}>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: '700', display: 'block', marginBottom: '4px' }}>沟通渠道类型 *</label>
                <select
                  style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                  value={newLogData.type}
                  onChange={e => setNewLogData({ ...newLogData, type: e.target.value })}
                >
                  <option value="phone">📞 电话问诊录音</option>
                  <option value="wechat">💬 企微/微信随访</option>
                  <option value="ocr">📄 化验单/病历 OCR 识别</option>
                  <option value="video">📹 视频随访记录</option>
                </select>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: '700', display: 'block', marginBottom: '4px' }}>记录标题</label>
                <input
                  type="text"
                  style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #cbd5e1', fontSize: '13px' }}
                  placeholder="如：5月25日 术后复查电话"
                  value={newLogData.title}
                  onChange={e => setNewLogData({ ...newLogData, title: e.target.value })}
                />
              </div>
              <div style={{ marginBottom: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <label style={{ fontSize: '12px', fontWeight: '700' }}>原始记录内容文本 *</label>
                  <button
                    type="button"
                    style={{ fontSize: '11px', color: '#0d9488', border: 'none', background: 'transparent', cursor: 'pointer', fontWeight: '700' }}
                    onClick={() => {
                      const template = SAMPLE_TEMPLATES[newLogData.type] || SAMPLE_TEMPLATES.phone;
                      setNewLogData({ ...newLogData, title: template.title, content: template.content });
                    }}
                  >
                    填入预置示例
                  </button>
                </div>
                <textarea
                  required
                  rows={6}
                  style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #cbd5e1', fontSize: '13px', lineHeight: '1.5' }}
                  placeholder="请输入真实的问诊交谈或化验单文本..."
                  value={newLogData.content}
                  onChange={e => setNewLogData({ ...newLogData, content: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button type="button" onClick={() => setShowLogModal(false)} style={{ padding: '8px 16px', borderRadius: '10px', border: '1px solid #e2e8f0', background: '#f8fafc', fontWeight: '700', cursor: 'pointer' }}>取消</button>
                <button type="submit" className="btn-action-sync">保存记录</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
