import React, { useState, useEffect } from 'react';
import { marked } from 'marked';
import { diffLines } from './utils/diff';
import HealthWikiRenderer from './components/HealthWikiRenderer';

// ──────────────────── 预置示例模板 ────────────────────
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
    content: `患者（张三） 10:15 : 医生，我按照你说的把“氨氯地平”吃回去了，今天早上量的血压是 136/86，头晕脑胀的感觉好多了，就是感觉有点口干，脚踝好像有一点点肿。
健康管理师 10:17 : 血压下来了是个好现象。苯磺酸氨氯地平可能会引起轻微的下肢水肿（特别是脚踝）和口干，这是常见的副作用。建议你平时多喝水，睡觉时可以用枕头稍微把脚垫高。
患者（张三） 10:19 : 好的，那这药还要继续吃吗？
健康管理师 10:20 : 要继续吃，千万不能再停。我会把脚踝轻度水肿和口干的情况记录在你的 Wiki 档案中。如果水肿加重或者出现心慌，请及时联系我们。下周三记得准时复诊。`
  },
  ocr: {
    title: '生化化验单 OCR 识别',
    content: `报告名称：心血管及血脂生化检查单
检测医院：人民第一医院
报告日期：2026-05-20
患者姓名：张三
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
    case 'medical_history.md': return '🧬 既往史与诊疗时间轴';
    case 'medication_plan.md': return '💊 用药方案与生活医嘱';
    case 'communication_timeline.md': return '📅 随访与沟通摘要';
    default: return filename;
  }
};

export default function App() {
  // ── 状态管理 ─────────────────────────────────
  const [clients, setClients] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [selectedClient, setSelectedClient] = useState(null);
  const [wikiPages, setWikiPages] = useState({});
  const [activeWikiPage, setActiveWikiPage] = useState('index.md');
  const [logs, setLogs] = useState([]);
  const [activeTab, setActiveTab] = useState('wiki'); // 'wiki' | 'logs'
  const [searchQuery, setSearchQuery] = useState('');
  
  // 编辑与弹窗状态
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [newClientData, setNewClientData] = useState({ name: '', age: '', gender: '男', phone: '', allergies: '' });
  const [editClientData, setEditClientData] = useState({ name: '', age: '', gender: '男', phone: '', allergies: '' });
  
  const [showLogModal, setShowLogModal] = useState(false);
  const [newLogData, setNewLogData] = useState({ type: 'phone', title: '', content: '' });
  
  // 维基手动编辑
  const [isEditingWiki, setIsEditingWiki] = useState(false);
  const [wikiEditContent, setWikiEditContent] = useState('');

  // 加载与通知状态
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [alert, setAlert] = useState(null);

  // 活体 Wiki 差异与高亮状态
  const [prevWikiPages, setPrevWikiPages] = useState({});
  const [showDiff, setShowDiff] = useState(false);

  // 溯源对照面板状态
  const [selectedLogForTrace, setSelectedLogForTrace] = useState(null);
  const [tracePanelOpen, setTracePanelOpen] = useState(false);

  // ── 副作用监听 ───────────────────────────────
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
    setIsEditingWiki(false);
    setPrevWikiPages({});
    setShowDiff(false);
  }, [selectedClientId]);

  // ── API 请求方法 ──────────────────────────────

  const fetchClients = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/clients');
      const data = await res.json();
      setClients(data);
      if (data.length > 0 && !selectedClientId) {
        setSelectedClientId(data[0].id);
      }
    } catch (err) {
      showToast('获取客户列表失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchClientDetails = async (clientId) => {
    try {
      // 1. 获取基本信息
      const clientRes = await fetch('/api/clients');
      const clientsList = await clientRes.json();
      const current = clientsList.find(c => c.id === clientId);
      setSelectedClient(current);

      // 2. 获取 Wiki 页面
      const wikiRes = await fetch(`/api/clients/${clientId}/wiki`);
      const wikiData = await wikiRes.json();
      setWikiPages(wikiData);
      if (!wikiData[activeWikiPage]) {
        const availablePages = Object.keys(wikiData);
        if (availablePages.length > 0) {
          setActiveWikiPage(availablePages[0]);
        }
      }

      // 3. 获取原始日志
      const logsRes = await fetch(`/api/clients/${clientId}/logs`);
      const logsData = await logsRes.json();
      setLogs(logsData);
    } catch (err) {
      showToast('获取客户档案失败', 'error');
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
      showToast('客户基本信息已更新', 'success');
      setShowEditModal(false);
      setSelectedClient(data);
      fetchClients();
    } catch (err) {
      showToast('更新客户信息失败', 'error');
    }
  };

  const handleDeleteClient = async () => {
    if (!window.confirm(`确定要彻底删除客户 ${selectedClient.name} 吗？此操作将永久抹除其全部日志和 Wiki 百科！`)) return;
    try {
      await fetch(`/api/clients/${selectedClientId}`, { method: 'DELETE' });
      showToast('客户档案已彻底删除', 'success');
      setSelectedClientId(null);
      fetchClients();
    } catch (err) {
      showToast('删除客户失败', 'error');
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

  const handleSaveWikiPage = async () => {
    try {
      await fetch(`/api/clients/${selectedClientId}/wiki/${activeWikiPage}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: wikiEditContent })
      });
      showToast('Wiki 页面手动更新成功', 'success');
      setIsEditingWiki(false);
      fetchClientDetails(selectedClientId);
    } catch (err) {
      showToast('保存 Wiki 失败', 'error');
    }
  };

  const handleLlmSync = async () => {
    try {
      setSyncing(true);
      // 在同步开始前缓存旧页面内容以供对比高亮
      setPrevWikiPages({ ...wikiPages });
      setShowDiff(true);
      showToast('开始调用豆包大模型，分析增量记录并重构Wiki...', 'info');
      const res = await fetch(`/api/clients/${selectedClientId}/sync`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        if (data.wikiUpdated) {
          showToast(`豆包大模型同步成功！已重构 Wiki: ${data.updatedFiles.join(', ')}`, 'success');
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
      const data = await res.json();
      if (res.ok) {
        return data.reply;
      } else {
        return `AI 助手解析失败: ${data.error}`;
      }
    } catch (err) {
      return `网络请求出错: ${err.message}`;
    }
  };

  // ── 辅助渲染方法 ─────────────────────────────

  const showToast = (message, type = 'success') => {
    setAlert({ message, type });
    setTimeout(() => setAlert(null), 5000);
  };

  const applyTemplate = (type) => {
    const tmpl = SAMPLE_TEMPLATES[type];
    if (tmpl) {
      setNewLogData({
        type,
        title: tmpl.title,
        content: tmpl.content
      });
    }
  };

  const handleClearHighlights = () => {
    setPrevWikiPages({});
    setShowDiff(false);
  };

  const scrollToHeading = (id) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const currentRawMarkdown = wikiPages[activeWikiPage] || '# 页面为空\n点击右上角开始编辑';

  const handleWikiLinkClick = (e) => {
    const target = e.target.closest('a');
    if (target) {
      const href = target.getAttribute('href');
      if (href && href.endsWith('.md') && !href.startsWith('http')) {
        e.preventDefault();
        setActiveWikiPage(href);
        setIsEditingWiki(false);
      }
    }
  };

  const { toc, processedHtml } = React.useMemo(() => {
    let processed = currentRawMarkdown;

    // 1. 进行差异对比
    if (showDiff && prevWikiPages[activeWikiPage]) {
      processed = diffLines(prevWikiPages[activeWikiPage], processed);
    }

    // 2. 生成目录大纲 (TOC) 并保持原始 markdown 标题给 marked 正常解析
    const tocList = [];
    let headingIndex = 0;
    const lines = processed.split('\n');
    for (const line of lines) {
      const match = line.match(/^(#{1,3})\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        // 过滤链接格式，使其在目录中纯文本显示
        const text = match[2].replace(/\[(.*?)\]\(.*?\)/g, '$1').trim();
        const id = `heading-${headingIndex++}`;
        tocList.push({ level, text, id });
      }
    }

    // 3. 将 GitHub 警示框语法转换为带类名的 HTML 结构
    let processedText = processed.replace(/>\s*\[!(NOTE|IMPORTANT|WARNING|TIP|CAUTION)\]\n([\s\S]*?)(?=\n\n|\n[^>])/g, (match, type, content) => {
      const cleanContent = content.split('\n').map(line => line.replace(/^>\s?/, '')).join('<br/>');
      const label = type === 'IMPORTANT' ? '红线警示' : type === 'NOTE' ? '核心备注' : type === 'WARNING' ? '重要警告' : type === 'TIP' ? '健康提示' : '危险防范';
      return `<div class="alert-block alert-${type.toLowerCase()}"><strong>⚠️ ${label}</strong><p>${cleanContent}</p></div>`;
    });

    // 4. 解析 Markdown (由于保留了原始标题语法，列表解析恢复完全正常)
    let html = marked.parse(processedText);

    // 5. 后置注入标题 ID，保证 TOC 定位锚点正确
    let htmlHeadingIndex = 0;
    html = html.replace(/<(h[1-3])(\s|>)/gi, (match, tagName, suffix) => {
      const id = `heading-${htmlHeadingIndex++}`;
      return `<${tagName} id="${id}"${suffix}`;
    });

    // 6. 替换自定义 diff 标记
    html = html.replace(/<p>\s*<diff-added-block>\s*<\/p>/g, '<diff-added-block>');
    html = html.replace(/<p>\s*<\/diff-added-block>\s*<\/p>/g, '</diff-added-block>');
    html = html.replace(/<diff-added-block>/g, '<div class="diff-added">');
    html = html.replace(/<\/diff-added-block>/g, '</div>');

    return { toc: tocList, processedHtml: html };
  }, [currentRawMarkdown, activeWikiPage, prevWikiPages, showDiff]);

  const filteredClients = clients.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (c.phone && c.phone.includes(searchQuery))
  );

  const hasUnsyncedLogs = logs.some(l => !l.synced);

  return (
    <div className="app-container">
      {/* ── 顶部 Toast 通知 ── */}
      {alert && (
        <div className={`toast toast-${alert.type}`}>
          <div className="toast-content">{alert.message}</div>
          <button className="toast-close" onClick={() => setAlert(null)}>&times;</button>
        </div>
      )}

      {/* ── 主框架布局 ── */}
      <div className="main-layout">
        
        {/* ── 左侧栏：客户管理 ── */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="logo-section">
              <span className="logo-icon">📖</span>
              <div className="logo-text">
                <h1>LLM Customer Wiki</h1>
                <p>基于豆包大模型的增量健康档案</p>
              </div>
            </div>
            <button className="btn-primary" onClick={() => setShowAddModal(true)}>
              <span>+</span> 新建客户档案
            </button>
          </div>

          <div className="search-box">
            <input
              type="text"
              placeholder="🔍 搜索姓名或电话..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="client-list">
            {loading ? (
              <div className="loading-state">正在加载客户列表...</div>
            ) : filteredClients.length === 0 ? (
              <div className="empty-state">没有找到符合条件的客户</div>
            ) : (
              filteredClients.map(client => {
                const clientLogs = client.id === selectedClientId ? logs : [];
                // 这里用个简化规则判断是否有未同步日志
                return (
                  <div
                    key={client.id}
                    className={`client-item ${selectedClientId === client.id ? 'active' : ''}`}
                    onClick={() => setSelectedClientId(client.id)}
                  >
                    <div className="client-avatar">
                      {client.name.substring(0, 1)}
                    </div>
                    <div className="client-info">
                      <div className="client-meta">
                        <span className="client-name">{client.name}</span>
                        <span className="client-gender-age">
                          {client.gender} | {client.age ? `${client.age}岁` : '未知'}
                        </span>
                      </div>
                      <div className="client-phone">{client.phone || '无电话'}</div>
                    </div>
                    {/* 未同步提示红点 */}
                    {client.id === selectedClientId ? (
                      hasUnsyncedLogs && <span className="badge-pulse">待同步</span>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* ── 右侧工作区 ── */}
        <main className="content-pane">
          {selectedClient ? (
            <div className="client-details-container">
              {/* 客户页眉看板 */}
              <header className="client-dashboard-header">
                <div className="client-main-profile">
                  <h2>{selectedClient.name}</h2>
                  <div className="profile-tags">
                    <span className="tag tag-gender">{selectedClient.gender}</span>
                    {selectedClient.age && <span className="tag tag-age">{selectedClient.age} 岁</span>}
                    {selectedClient.phone && <span className="tag tag-phone">📞 {selectedClient.phone}</span>}
                  </div>
                  {selectedClient.allergies && (
                    <div className="profile-allergies">
                      <span className="allergy-label">⚠️ 过敏史:</span>
                      <span className="allergy-value">{selectedClient.allergies}</span>
                    </div>
                  )}
                </div>

                <div className="sync-control-panel">
                  <div className="sync-status-info">
                    <span className="label">上次大模型汇总:</span>
                    <span className="value">
                      {selectedClient.lastSyncAt
                        ? new Date(selectedClient.lastSyncAt).toLocaleString()
                        : '从未同步'}
                    </span>
                  </div>
                  
                  <button
                    className={`btn-sync ${hasUnsyncedLogs ? 'pulse-border' : ''} ${syncing ? 'syncing' : ''}`}
                    onClick={handleLlmSync}
                    disabled={syncing}
                  >
                    <span className="sync-icon">🔄</span>
                    {syncing ? '豆包大模型智能同步中...' : '同步 Wiki (豆包)'}
                    {hasUnsyncedLogs && !syncing && <span className="badge-new-data">有新沟通数据</span>}
                  </button>
                </div>
              </header>

              {/* 行为和设置条 */}
              <div className="action-bar">
                <div className="view-tabs">
                  <button
                    className={`tab-btn ${activeTab === 'wiki' ? 'active' : ''}`}
                    onClick={() => setActiveTab('wiki')}
                  >
                    📖 客户专属 Wiki 百科
                  </button>
                  <button
                    className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
                    onClick={() => setActiveTab('logs')}
                  >
                    💬 原始沟通日志 ({logs.length})
                    {hasUnsyncedLogs && <span className="dot-red"></span>}
                  </button>
                </div>

                <div className="client-ops">
                  <button className="btn-secondary" onClick={() => {
                    setEditClientData({
                      name: selectedClient.name,
                      age: selectedClient.age || '',
                      gender: selectedClient.gender || '男',
                      phone: selectedClient.phone || '',
                      allergies: selectedClient.allergies || ''
                    });
                    setShowEditModal(true);
                  }}>编辑基本资料</button>
                  <button className="btn-danger" onClick={handleDeleteClient}>删除客户</button>
                </div>
              </div>

              {/* 页签内容区 */}
              <div className="tab-content-container">
                {/* 页签 1: Wiki 页面显示 */}
                {activeTab === 'wiki' && (
                  <div className="wiki-workspace">
                    <aside className="wiki-nav">
                      <div className="nav-title">Wiki 页面目录</div>
                      <button
                        className={`wiki-nav-item ${activeWikiPage === 'index.md' ? 'active' : ''}`}
                        onClick={() => { setActiveWikiPage('index.md'); setIsEditingWiki(false); }}
                      >
                        🏠 客户健康首页
                      </button>
                      <button
                        className={`wiki-nav-item ${activeWikiPage === 'medical_history.md' ? 'active' : ''}`}
                        onClick={() => { setActiveWikiPage('medical_history.md'); setIsEditingWiki(false); }}
                      >
                        🧬 既往史与诊疗轴
                      </button>
                      <button
                        className={`wiki-nav-item ${activeWikiPage === 'medication_plan.md' ? 'active' : ''}`}
                        onClick={() => { setActiveWikiPage('medication_plan.md'); setIsEditingWiki(false); }}
                      >
                        💊 用药与生活医嘱
                      </button>
                      <button
                        className={`wiki-nav-item ${activeWikiPage === 'communication_timeline.md' ? 'active' : ''}`}
                        onClick={() => { setActiveWikiPage('communication_timeline.md'); setIsEditingWiki(false); }}
                      >
                        📅 随访与沟通摘要
                      </button>
                    </aside>

                    <div className="wiki-body-panel">
                      {/* 增量差异高亮顶部条 */}
                      {showDiff && Object.keys(prevWikiPages).length > 0 && (
                        <div className="diff-alert-banner">
                          <div className="banner-info">
                            <span className="banner-icon">✨</span>
                            <span className="banner-text">检测到大模型对本页进行了增量更新，已高亮显示最近变动</span>
                          </div>
                          <button className="btn-clear-diff" onClick={handleClearHighlights}>清除高亮</button>
                        </div>
                      )}

                      <div className="wiki-body-header">
                        <div className="wiki-page-title">{getPageDisplayName(activeWikiPage)}</div>
                        {!isEditingWiki ? (
                          <button className="btn-secondary" onClick={() => {
                            setWikiEditContent(wikiPages[activeWikiPage] || '');
                            setIsEditingWiki(true);
                          }}>手动编辑此页</button>
                        ) : (
                          <div className="edit-actions">
                            <button className="btn-success" onClick={handleSaveWikiPage}>确认保存</button>
                            <button className="btn-secondary" onClick={() => setIsEditingWiki(false)}>取消</button>
                          </div>
                        )}
                      </div>

                      <div className="wiki-body-content-wrapper">
                        <div className="wiki-body-content">
                          {isEditingWiki ? (
                            <textarea
                              className="wiki-editor-textarea"
                              value={wikiEditContent}
                              onChange={(e) => setWikiEditContent(e.target.value)}
                              placeholder="编写 Markdown 内容..."
                            />
                          ) : (
                            <HealthWikiRenderer
                              markdownContent={wikiPages[activeWikiPage]}
                              prevMarkdownContent={prevWikiPages[activeWikiPage]}
                              showDiff={showDiff}
                              logSources={logs}
                              personMeta={selectedClient}
                              onOpenReference={handleOpenReference}
                              onSelectionAction={handleSelectionAction}
                            />
                          )}
                        </div>

                        {/* 右侧动态目录大纲 (TOC) */}
                        {!isEditingWiki && toc.length > 0 && (
                          <aside className="wiki-toc">
                            <div className="toc-title">章节导航</div>
                            <ul className="toc-list">
                              {toc.map(item => (
                                <li
                                  key={item.id}
                                  className={`toc-item level-${item.level}`}
                                  onClick={() => scrollToHeading(item.id)}
                                >
                                  {item.text}
                                </li>
                              ))}
                            </ul>
                          </aside>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* 页签 2: 沟通记录 */}
                {activeTab === 'logs' && (
                  <div className="logs-workspace">
                    <div className="logs-header">
                      <h3>沟通接触史 (ASR/企微/OCR)</h3>
                      <button className="btn-primary" onClick={() => setShowLogModal(true)}>
                        + 录入新沟通记录
                      </button>
                    </div>

                    <div className="logs-timeline">
                      {logs.length === 0 ? (
                        <div className="empty-logs">
                          <p>暂无任何原始沟通记录</p>
                          <p className="subtext">请点击右上角录入第一条问诊转录或单证 OCR 记录</p>
                        </div>
                      ) : (
                        [...logs].reverse().map(log => (
                          <div key={log.id} className={`log-card ${!log.synced ? 'unsynced' : ''}`}>
                            <div className="log-card-header">
                              <div className="log-type-tag">
                                <span className={`type-badge type-${log.type}`}>
                                  {log.type === 'phone' ? '📞 电话问诊' :
                                   log.type === 'video' ? '📹 视频问诊' :
                                   log.type === 'wechat' ? '💬 企微记录' : '📄 单证 OCR'}
                                </span>
                                <h4 className="log-title">{log.title}</h4>
                              </div>
                              <div className="log-meta">
                                <span className="log-time">{new Date(log.timestamp).toLocaleString()}</span>
                                <span className={`sync-badge ${log.synced ? 'synced' : 'pending'}`}>
                                  {log.synced ? '● 已融入 Wiki' : '○ 待模型同步'}
                                </span>
                              </div>
                            </div>
                            <div className="log-card-body">
                              <pre>{log.content}</pre>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="welcome-panel">
              <div className="welcome-glass">
                <span className="welcome-logo">📖</span>
                <h2>欢迎使用 LLM 客户专属 Wiki 系统</h2>
                <p>本系统采用 <strong>LLM Wiki (大模型增量建库)</strong> 架构。</p>
                <p className="welcome-desc">
                  与传统向量检索 (RAG) 方式不同，系统会将客户每一次的电话问诊转录、视频会话、企微聊天记录、体检化验单
                  进行整合提炼，增量更新至对应客户的专属维基页面中，形成连续的、结构化的全景健康档案。
                </p>
                <div className="welcome-stats">
                  <div className="stat-item">
                    <span className="num">{clients.length}</span>
                    <span className="lbl">客户总数</span>
                  </div>
                  <div className="stat-item">
                    <span className="num">豆包-1.5-Pro</span>
                    <span className="lbl">当前驱动模型</span>
                  </div>
                </div>
                <button className="btn-primary" onClick={() => setShowAddModal(true)}>
                  立即创建首个客户
                </button>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ── 弹窗模版 1: 新建客户 ── */}
      {showAddModal && (
        <div className="modal-overlay">
          <div className="modal-container">
            <div className="modal-header">
              <h3>新建客户健康档案</h3>
              <button className="btn-close" onClick={() => setShowAddModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleCreateClient}>
              <div className="form-group">
                <label>姓名 *</label>
                <input
                  type="text"
                  required
                  placeholder="请输入姓名"
                  value={newClientData.name}
                  onChange={(e) => setNewClientData({ ...newClientData, name: e.target.value })}
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>年龄</label>
                  <input
                    type="number"
                    placeholder="请输入年龄"
                    value={newClientData.age}
                    onChange={(e) => setNewClientData({ ...newClientData, age: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>性别</label>
                  <select
                    value={newClientData.gender}
                    onChange={(e) => setNewClientData({ ...newClientData, gender: e.target.value })}
                  >
                    <option value="男">男</option>
                    <option value="女">女</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>联系电话</label>
                <input
                  type="text"
                  placeholder="输入联系电话"
                  value={newClientData.phone}
                  onChange={(e) => setNewClientData({ ...newClientData, phone: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>红线警示 / 过敏史及慢病</label>
                <textarea
                  placeholder="如：头孢类过敏、青霉素过敏、5年高血压史等"
                  value={newClientData.allergies}
                  onChange={(e) => setNewClientData({ ...newClientData, allergies: e.target.value })}
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowAddModal(false)}>取消</button>
                <button type="submit" className="btn-primary">确定创建</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── 弹窗模版 2: 编辑客户基本资料 ── */}
      {showEditModal && (
        <div className="modal-overlay">
          <div className="modal-container">
            <div className="modal-header">
              <h3>编辑客户资料</h3>
              <button className="btn-close" onClick={() => setShowEditModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleUpdateClient}>
              <div className="form-group">
                <label>姓名 *</label>
                <input
                  type="text"
                  required
                  value={editClientData.name}
                  onChange={(e) => setEditClientData({ ...editClientData, name: e.target.value })}
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>年龄</label>
                  <input
                    type="number"
                    value={editClientData.age}
                    onChange={(e) => setEditClientData({ ...editClientData, age: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>性别</label>
                  <select
                    value={editClientData.gender}
                    onChange={(e) => setEditClientData({ ...editClientData, gender: e.target.value })}
                  >
                    <option value="男">男</option>
                    <option value="女">女</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>联系电话</label>
                <input
                  type="text"
                  value={editClientData.phone}
                  onChange={(e) => setEditClientData({ ...editClientData, phone: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>红线警示 / 过敏史及慢病</label>
                <textarea
                  value={editClientData.allergies}
                  onChange={(e) => setEditClientData({ ...editClientData, allergies: e.target.value })}
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowEditModal(false)}>取消</button>
                <button type="submit" className="btn-primary">保存修改</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── 弹窗模版 3: 新增沟通记录 (含示例注入) ── */}
      {showLogModal && (
        <div className="modal-overlay">
          <div className="modal-container log-modal">
            <div className="modal-header">
              <h3>录入原始沟通记录</h3>
              <button className="btn-close" onClick={() => setShowLogModal(false)}>&times;</button>
            </div>
            <div className="template-selectors">
              <span className="lbl">一键填入测试数据：</span>
              <button type="button" className="btn-template tmpl-phone" onClick={() => applyTemplate('phone')}>
                📞 电话问诊记录
              </button>
              <button type="button" className="btn-template tmpl-wechat" onClick={() => applyTemplate('wechat')}>
                💬 企微随访记录
              </button>
              <button type="button" className="btn-template tmpl-ocr" onClick={() => applyTemplate('ocr')}>
                📄 化验单 OCR
              </button>
            </div>
            <form onSubmit={handleAddLog}>
              <div className="form-row">
                <div className="form-group">
                  <label>记录类型 *</label>
                  <select
                    value={newLogData.type}
                    onChange={(e) => setNewLogData({ ...newLogData, type: e.target.value })}
                  >
                    <option value="phone">📞 电话医生问诊</option>
                    <option value="video">📹 视频医生问诊</option>
                    <option value="wechat">💬 企业微信沟通</option>
                    <option value="ocr">📄 单证 OCR 识别文本</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>记录标题</label>
                  <input
                    type="text"
                    placeholder="如：5月21日用药随访（留空则自动生成）"
                    value={newLogData.title}
                    onChange={(e) => setNewLogData({ ...newLogData, title: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>原始沟通文本 / ASR转录 / OCR内容 *</label>
                <textarea
                  className="log-content-textarea"
                  required
                  placeholder="请在此输入或粘贴详细沟通文字，或点击上方模板一键生成..."
                  value={newLogData.content}
                  onChange={(e) => setNewLogData({ ...newLogData, content: e.target.value })}
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowLogModal(false)}>取消</button>
                <button type="submit" className="btn-primary">确定录入</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── 4. 右侧滑入式原始日志双向对照面板 ── */}
      {tracePanelOpen && selectedLogForTrace && (
        <div className="trace-slider-overlay" onClick={() => setTracePanelOpen(false)}>
          <div className="trace-slider-panel" onClick={(e) => e.stopPropagation()}>
            <div className="trace-slider-header">
              <h3>🔍 原始依据对照面板</h3>
              <button className="btn-close-slider" onClick={() => setTracePanelOpen(false)}>&times;</button>
            </div>
            
            <div className="trace-slider-meta">
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span className={`type-badge type-${selectedLogForTrace.type}`}>
                  {selectedLogForTrace.type === 'phone' ? '📞 电话问诊' :
                   selectedLogForTrace.type === 'video' ? '📹 视频问诊' :
                   selectedLogForTrace.type === 'wechat' ? '💬 企微记录' : '📄 单证 OCR'}
                </span>
                <strong>{selectedLogForTrace.title}</strong>
              </div>
              <div style={{ color: '#64748b', fontSize: '0.8rem', marginTop: '6px' }}>
                记录时间：{new Date(selectedLogForTrace.timestamp).toLocaleString()}
              </div>
            </div>

            <div className="trace-slider-body">
              <div className="trace-instruction">
                💡 原文高亮行为该 Wiki 条目对应的事实依据出处：
              </div>
              <div className="trace-original-content">
                <pre>{selectedLogForTrace.content}</pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
