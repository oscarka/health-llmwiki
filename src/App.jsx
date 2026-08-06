import React, { useState, useEffect } from 'react';
import { marked } from 'marked';
import { diffLines } from './utils/diff';
import HealthWikiRenderer from './components/HealthWikiRenderer';
import AnatomicalHealthMap from './components/AnatomicalHealthMap';

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

// ── 动态生命体征提取模型 (以 Wiki 现存数据为基底动态推断) ──
function extractVitalSigns(wikiPages) {
  let spo2 = { value: '—', unit: '%',     status: '未记录', className: 'no-data', history: [] };
  let bp   = { value: '—', unit: 'mmHg',  status: '未记录', className: 'no-data', history: [] };
  let bg   = { value: '—', unit: 'mmol/L',status: '未记录', className: 'no-data', history: [] };
  let temp = { value: '—', unit: '℃',     status: '未记录', className: 'no-data', history: [] };

  const allContent = Object.values(wikiPages).join('\n');

  // 1. SpO2 — 提取所有出现的血氧数值（历史序列）
  const spo2Matches = [...allContent.matchAll(/(?:血氧|spo2|SpO2)\D{0,12}?(\d{2,3})\s*%/gi)];
  const spo2Vals = spo2Matches.map(m => parseInt(m[1])).filter(v => v >= 70 && v <= 100);
  if (spo2Vals.length > 0) {
    const latest = spo2Vals[spo2Vals.length - 1];
    spo2.value = latest.toString();
    spo2.history = spo2Vals.slice(-8);
    if (latest < 90) { spo2.status = '高危'; spo2.className = 'danger-alert'; }
    else if (latest < 95) { spo2.status = '偏低'; spo2.className = 'warning-alert'; }
  } else {
    const m = allContent.match(/(?:血氧|spo2|SpO2)\D*(\d{2,3})/i);
    if (m) {
      const val = parseInt(m[1]);
      spo2.value = val.toString();
      if (val < 90) { spo2.status = '高危'; spo2.className = 'danger-alert'; }
      else if (val < 95) { spo2.status = '偏低'; spo2.className = 'warning-alert'; }
    }
  }

  // 2. Blood Pressure — 提取所有 收缩压/舌张压 对（mmHg）
  const bpMatches = [...allContent.matchAll(/(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:mmHg|mm\s*Hg)/gi)];
  const bpVals = bpMatches.map(m => ({ sys: parseInt(m[1]), dia: parseInt(m[2]) }))
    .filter(v => v.sys >= 60 && v.sys <= 260 && v.dia >= 30 && v.dia <= 160);
  if (bpVals.length > 0) {
    const latest = bpVals[bpVals.length - 1];
    bp.value = `${latest.sys}/${latest.dia}`;
    bp.history = bpVals.slice(-8).map(v => v.sys);
    if (latest.sys >= 180 || latest.dia >= 110) { bp.status = '高危'; bp.className = 'danger-alert'; }
    else if (latest.sys >= 140 || latest.dia >= 90) { bp.status = '异常'; bp.className = 'warning-alert'; }
  } else {
    const m = allContent.match(/(?:血压)\D*(\d{2,3}\/\d{2,3})/);
    if (m) {
      bp.value = m[1];
      const parts = m[1].split('/');
      if (parseInt(parts[0]) >= 140 || parseInt(parts[1]) >= 90) { bp.status = '异常'; bp.className = 'warning-alert'; }
    }
  }

  // 3. Blood Glucose — 必须有 mmol 单位才提取，否则保持默认值避免误匹配
  const bgMatches = [...allContent.matchAll(/(?:血糖|glucose)\D{0,12}?(\d+(?:\.\d+)?)\s*mmol/gi)];
  const bgVals = bgMatches.map(m => parseFloat(m[1])).filter(v => v >= 2.0 && v <= 35.0);
  if (bgVals.length > 0) {
    const latest = bgVals[bgVals.length - 1];
    bg.value = latest.toString();
    bg.history = bgVals.slice(-8);
    if (latest >= 10.0 || latest < 3.9) { bg.status = '高危'; bg.className = 'danger-alert'; }
    else if (latest >= 7.0) { bg.status = '异常'; bg.className = 'warning-alert'; }
  }
  // 无有效带单位数值时保持默认值 5.4，不猜测

  // 4. Temperature — 提取所有体温数值（摄氏度）
  const tempMatches = [...allContent.matchAll(/(?:体温)\s*[\s：:]?\s*(\d{2}(?:\.\d+)?)\s*[℃°C]/gi)];
  const tempVals = tempMatches.map(m => parseFloat(m[1])).filter(v => v >= 35.0 && v <= 42.0);
  if (tempVals.length > 0) {
    const latest = tempVals[tempVals.length - 1];
    temp.value = latest.toString();
    temp.history = tempVals.slice(-8);
    if (latest >= 38.0) { temp.status = '发热'; temp.className = 'danger-alert'; }
    else if (latest >= 37.3) { temp.status = '低热'; temp.className = 'warning-alert'; }
  } else {
    // 兜底：必须"体温"紧接数字+℃单位
    const m = allContent.match(/体温[\s：:]*(\d{2}(?:\.\d+)?)[℃°C]/);
    if (m) {
      const val = parseFloat(m[1]);
      if (val >= 35.0 && val <= 42.0) {
        temp.value = val.toString();
        if (val >= 38.0) { temp.status = '发热'; temp.className = 'danger-alert'; }
        else if (val >= 37.3) { temp.status = '低热'; temp.className = 'warning-alert'; }
      }
    }
  }

  return { spo2, bp, bg, temp };
}

// ── Sparkline SVG 路径生成器 — 基于真实历史数据序列生成平滑贝塞尔曲线 ──
function buildSparklinePath(history, latestValue) {
  // 如果有2个以上真实数据点，就用真实数据；否则基于最新值生成自然扰动曲线
  let points = (history && history.length >= 2) ? history.slice(-8) : (() => {
    const base = parseFloat(latestValue) || 50;
    return Array.from({ length: 7 }, (_, i) =>
      base + (Math.sin(i * 1.3 + base * 0.07) * base * 0.025)
    );
  })();

  const n = points.length;
  if (n < 2) return '';

  const svgW = 100, svgH = 24, padV = 3;
  const dataMin = Math.min(...points);
  const dataMax = Math.max(...points);
  const dataRange = dataMax - dataMin || (dataMin * 0.05) || 1;

  const norm = (v) => padV + (1 - (v - dataMin) / dataRange) * (svgH - padV * 2);
  const xStep = svgW / (n - 1);

  let d = `M ${0} ${norm(points[0]).toFixed(1)}`;
  for (let i = 1; i < n; i++) {
    const x0 = (i - 1) * xStep;
    const y0 = norm(points[i - 1]);
    const x1 = i * xStep;
    const y1 = norm(points[i]);
    const cpX = (x0 + x1) / 2;
    d += ` C ${cpX.toFixed(1)} ${y0.toFixed(1)}, ${cpX.toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return d;
}

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

  // 侧边栏折叠状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ── 动态生命体征计算 ──
  const vitals = React.useMemo(() => {
    return extractVitalSigns(wikiPages);
  }, [wikiPages]);
 
  // ── Bento Dashboard 统计数据计算 ──────────────────────
  const severityStats = React.useMemo(() => {
    let high = 0;
    let medium = 0;
    let low = 0;
    
    Object.values(wikiPages).forEach(content => {
      if (!content) return;
      const matches = content.matchAll(/attention_score:\s*['"\u2018\u2019]?(\d+(?:\.\d+)?)/g);
      for (const match of matches) {
        const score = parseFloat(match[1]);
        if (score >= 0.8) high++;
        else if (score >= 0.5) medium++;
        else low++;
      }
    });

    const noData = high === 0 && medium === 0 && low === 0;
    return { high, medium, low, total: Math.max(high + medium + low, 1), noData };
  }, [wikiPages]);

  const syncStats = React.useMemo(() => {
    const syncedLogs = logs.filter(l => l.synced).length;
    const total = logs.length;
    const progress = total > 0 ? Math.round((syncedLogs / total) * 100) : 100;
    const confidence = total > 0 ? Math.min(98, 85 + Math.round((syncedLogs / total) * 13)) : 92;
    return { progress, confidence, total, syncedLogs };
  }, [logs]);

  // ── 副作用监听 ───────────────────────────────
  useEffect(() => {
    fetchClients();
  }, []);

  useEffect(() => {
    if (selectedClientId) {
      fetchClientDetails(selectedClientId);
      if (window.innerWidth < 1600) {
        setSidebarCollapsed(true);
      }
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
      <div className={`main-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        
        {/* ── 左侧栏：客户管理 ── */}
        <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-header" style={{ gap: '16px', display: 'flex', flexDirection: 'column' }}>
            <div className="logo-section" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div className="logo-icon-container" style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'var(--primary-glow)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="material-symbols-outlined icon-fill" style={{ color: 'var(--primary)', fontSize: '24px' }}>analytics</span>
                </div>
                <div className="logo-text">
                  <h1 style={{ fontSize: '16px', fontWeight: '800', color: 'var(--primary)', letterSpacing: '0.5px', margin: 0 }}>LLM Wiki Health</h1>
                  <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px', margin: 0 }}>AI Diagnostic Suite</p>
                </div>
              </div>
              <button 
                className="btn-sidebar-collapse"
                onClick={() => setSidebarCollapsed(true)}
                title="收起侧边栏"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>menu_open</span>
              </button>
            </div>
            <button className="btn-primary" onClick={() => setShowAddModal(true)} style={{ width: '100%', borderRadius: '12px', padding: '12px', display: 'flex', gap: '8px', justifyContent: 'center', alignItems: 'center' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
              新建客户档案
            </button>
          </div>

          <div className="search-box" style={{ position: 'relative', padding: '0 20px 16px 20px' }}>
            <span className="material-symbols-outlined" style={{ position: 'absolute', left: '32px', top: '10px', color: 'var(--text-secondary)', fontSize: '18px' }}>search</span>
            <input
              type="text"
              placeholder="搜索患者姓名或电话..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ paddingLeft: '38px', borderRadius: '20px' }}
            />
          </div>

          <div className="client-list" style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div className="loading-state">正在加载客户列表...</div>
            ) : filteredClients.length === 0 ? (
              <div className="empty-state">没有找到符合条件的客户</div>
            ) : (
              filteredClients.map(client => {
                const clientLogs = client.id === selectedClientId ? logs : [];
                const isActive = client.id === selectedClientId;
                return (
                  <div
                    key={client.id}
                    className={`client-item ${isActive ? 'active' : ''}`}
                    onClick={() => setSelectedClientId(client.id)}
                    style={{ 
                      borderRadius: '12px', 
                      padding: '12px 14px', 
                      border: isActive ? '1.5px solid var(--primary)' : '1px solid var(--border-color)', 
                      background: isActive ? 'rgba(0, 61, 166, 0.06)' : '#ffffff',
                      marginBottom: '8px', 
                      cursor: 'pointer', 
                      transition: 'all 0.2s ease' 
                    }}
                  >
                    <div className="client-avatar" style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-primary-fixed-dim) 0%, var(--color-secondary-fixed-dim) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '600', color: 'white', marginRight: '12px' }}>
                      {client.name.substring(0, 1)}
                    </div>
                    <div className="client-info" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div className="client-meta" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="client-name" style={{ fontSize: '13.5px', fontWeight: '600', color: 'var(--text-primary)' }}>{client.name.split('：')[0]}</span>
                        <span className="client-gender-age" style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          {client.gender} | {client.age ? `${client.age}岁` : '未知'}
                        </span>
                      </div>
                      <div className="client-phone" style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>{client.phone || '无电话'}</div>
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
          
          <div className="sidebar-footer" style={{ padding: '16px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--color-surface-container-low)' }}>
            <div className="doctor-avatar" style={{ width: '38px', height: '38px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-primary-fixed-dim) 0%, var(--color-secondary-fixed-dim) 100%)', flexShrink: 0 }}></div>
            <div className="doctor-info" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)' }}>Dr. S. Chen</span>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>Lead Diagnostician</span>
            </div>
          </div>
        </aside>

        {/* ── 右侧工作区 ── */}
        <main className="content-pane" style={{ position: 'relative' }}>
          {sidebarCollapsed && (
            <button 
              className="btn-sidebar-expand-floating" 
              onClick={() => setSidebarCollapsed(false)} 
              title="展开侧边栏"
            >
              <span className="material-symbols-outlined">menu</span>
            </button>
          )}
          {selectedClient ? (
            <div className="client-details-container">
              {/* 客户页眉看板 (方案 D Bento 临床监控看板) */}
              <header className="client-dashboard-header">
                {/* Col 1: 患者基本信息 */}
                <div className="patient-profile-card">
                  <div className="patient-avatar">{selectedClient.name.substring(0, 1)}</div>
                  <div className="patient-meta-info">
                    <div className="patient-name-row">
                      <span className="patient-name">{selectedClient.name.split('：')[0]}</span>
                      <span className="patient-tags">{selectedClient.gender} · {selectedClient.age ? `${selectedClient.age}岁` : '未知'}</span>
                    </div>
                    <div className="patient-phone">📞 {selectedClient.phone || '无电话'}</div>
                    {selectedClient.allergies ? (
                      <div className="patient-allergy-bar" title={selectedClient.allergies}>
                        ⚠️ {selectedClient.allergies.substring(0, 18)}
                      </div>
                    ) : (
                      <div className="patient-allergy-bar" style={{ color: 'var(--success)', background: 'rgba(0,108,71,0.06)', border: '1px solid rgba(0,108,71,0.15)' }}>
                        ✓ 暂无药物过敏登记
                      </div>
                    )}
                  </div>
                </div>

                {/* Col 2: 核心体征监测 */}
                <div className="vitals-monitor-panel">
                  {/* SpO2 */}
                  <div className={`vital-widget ${vitals.spo2.className}`}>
                    <div className="vital-label">
                      <span className="material-symbols-outlined" style={{ fontSize: '13px', color: vitals.spo2.className === 'no-data' ? '#cbd5e1' : vitals.spo2.className ? '#ef4444' : '#003da6' }}>oxygen_saturation</span>
                      血氧饱和度
                    </div>
                    <div className={`vital-value-row ${vitals.spo2.className}`}>
                      <span className="vital-value">{vitals.spo2.value}<span className="vital-unit">%</span></span>
                      <span className={`vital-status-tag ${vitals.spo2.className === 'no-data' ? 'no-data' : vitals.spo2.className === 'danger-alert' ? 'danger' : vitals.spo2.className ? 'warning' : ''}`} style={!vitals.spo2.className ? { background: 'rgba(0,108,71,0.08)', color: '#006c47' } : {}}>
                        {vitals.spo2.status}
                      </span>
                    </div>
                    {vitals.spo2.className !== 'no-data' && (
                      <div className="vital-sparkline">
                        <svg viewBox="0 0 100 24" width="100%" height="24">
                          <path d={buildSparklinePath(vitals.spo2.history, vitals.spo2.value)} fill="none" stroke={vitals.spo2.className === 'danger-alert' ? '#ef4444' : vitals.spo2.className ? '#f59e0b' : '#0052d9'} strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* BP */}
                  <div className={`vital-widget ${vitals.bp.className}`}>
                    <div className="vital-label">
                      <span className="material-symbols-outlined" style={{ fontSize: '13px', color: vitals.bp.className === 'no-data' ? '#cbd5e1' : vitals.bp.className ? '#ba1a1a' : '#006c47' }}>bloodpressure</span>
                      患者血压
                    </div>
                    <div className={`vital-value-row ${vitals.bp.className}`}>
                      <span className="vital-value">{vitals.bp.value}<span className="vital-unit">mmHg</span></span>
                      <span className={`vital-status-tag ${vitals.bp.className === 'no-data' ? 'no-data' : vitals.bp.className === 'danger-alert' ? 'danger' : vitals.bp.className ? 'warning' : ''}`} style={!vitals.bp.className ? { background: 'rgba(0,108,71,0.08)', color: '#006c47' } : {}}>
                        {vitals.bp.status}
                      </span>
                    </div>
                    {vitals.bp.className !== 'no-data' && (
                      <div className="vital-sparkline">
                        <svg viewBox="0 0 100 24" width="100%" height="24">
                          <path d={buildSparklinePath(vitals.bp.history, vitals.bp.value.split('/')[0])} fill="none" stroke={vitals.bp.className === 'danger-alert' ? '#ef4444' : vitals.bp.className ? '#f59e0b' : '#006c47'} strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* BG */}
                  <div className={`vital-widget ${vitals.bg.className}`}>
                    <div className="vital-label">
                      <span className="material-symbols-outlined" style={{ fontSize: '13px', color: vitals.bg.className === 'no-data' ? '#cbd5e1' : vitals.bg.className ? '#ba1a1a' : '#006c47' }}>water_drop</span>
                      空腹血糖
                    </div>
                    <div className={`vital-value-row ${vitals.bg.className}`}>
                      <span className="vital-value">{vitals.bg.value}<span className="vital-unit">mmol/L</span></span>
                      <span className={`vital-status-tag ${vitals.bg.className === 'no-data' ? 'no-data' : vitals.bg.className === 'danger-alert' ? 'danger' : vitals.bg.className ? 'warning' : ''}`} style={!vitals.bg.className ? { background: 'rgba(0,108,71,0.08)', color: '#006c47' } : {}}>
                        {vitals.bg.status}
                      </span>
                    </div>
                    {vitals.bg.className !== 'no-data' && (
                      <div className="vital-sparkline">
                        <svg viewBox="0 0 100 24" width="100%" height="24">
                          <path d={buildSparklinePath(vitals.bg.history, vitals.bg.value)} fill="none" stroke={vitals.bg.className === 'danger-alert' ? '#ef4444' : vitals.bg.className ? '#f59e0b' : '#006c47'} strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* Temp */}
                  <div className={`vital-widget ${vitals.temp.className}`}>
                    <div className="vital-label">
                      <span className="material-symbols-outlined" style={{ fontSize: '13px', color: vitals.temp.className === 'no-data' ? '#cbd5e1' : vitals.temp.className ? '#ef4444' : '#006c47' }}>device_thermostat</span>
                      核心体温
                    </div>
                    <div className={`vital-value-row ${vitals.temp.className}`}>
                      <span className="vital-value">{vitals.temp.value}<span className="vital-unit">℃</span></span>
                      <span className={`vital-status-tag ${vitals.temp.className === 'no-data' ? 'no-data' : vitals.temp.className === 'danger-alert' ? 'danger' : vitals.temp.className ? 'warning' : ''}`} style={!vitals.temp.className ? { background: 'rgba(0,108,71,0.08)', color: '#006c47' } : {}}>
                        {vitals.temp.status}
                      </span>
                    </div>
                    {vitals.temp.className !== 'no-data' && (
                      <div className="vital-sparkline">
                        <svg viewBox="0 0 100 24" width="100%" height="24">
                          <path d={buildSparklinePath(vitals.temp.history, vitals.temp.value)} fill="none" stroke={vitals.temp.className === 'danger-alert' ? '#ef4444' : vitals.temp.className ? '#f59e0b' : '#006c47'} strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </div>
                    )}
                  </div>
                </div>

                {/* Col 3: AI工作站同步状态 */}
                <div className="ai-station-card">
                  <div className="ai-station-stats">
                    <div className="ai-progress-bar-container">
                      <div className="ai-progress-label">
                        <span>日志融入率</span>
                        <span>{syncStats.syncedLogs} / {syncStats.total}</span>
                      </div>
                      <div className="ai-progress-track">
                        <div className="ai-progress-fill" style={{ width: `${syncStats.progress}%` }}></div>
                      </div>
                    </div>
                    <div className="ai-gauge-badge">
                      <span className="gauge-val">{syncStats.confidence}%</span>
                      <span className="gauge-lbl">置信度</span>
                    </div>
                  </div>
                  <div className="ai-action-row">
                    <span className="sync-time-lbl">
                      {selectedClient.lastSyncAt ? `上次汇总: ${new Date(selectedClient.lastSyncAt).getMonth() + 1}-${new Date(selectedClient.lastSyncAt).getDate()} ${new Date(selectedClient.lastSyncAt).getHours()}:${String(new Date(selectedClient.lastSyncAt).getMinutes()).padStart(2, '0')}` : '从未同步'}
                    </span>
                    <button
                      className={`btn-sync-action ${syncing ? 'syncing' : ''}`}
                      onClick={handleLlmSync}
                      disabled={syncing}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '13px', animation: syncing ? 'spin 1.5s linear infinite' : 'none' }}>sync</span>
                      {syncing ? '同步中...' : '同步 Wiki'}
                    </button>
                  </div>
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
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <button className="btn-secondary" onClick={() => {
                              const content = wikiPages[activeWikiPage] || '';
                              const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = activeWikiPage;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}>
                              <span className="material-symbols-outlined" style={{ fontSize: '16px', verticalAlign: 'middle', marginRight: '4px' }}>download</span>
                              下载 .md
                            </button>
                            <button className="btn-secondary" onClick={() => {
                              setWikiEditContent(wikiPages[activeWikiPage] || '');
                              setIsEditingWiki(true);
                            }}>手动编辑此页</button>
                          </div>
                        ) : (
                          <div className="edit-actions">
                            <button className="btn-success" onClick={handleSaveWikiPage}>确认保存</button>
                            <button className="btn-secondary" onClick={() => setIsEditingWiki(false)}>取消</button>
                          </div>
                        )}
                      </div>

                      <div className="wiki-body-content-wrapper">
                        <div className="wiki-body-content" style={{ padding: '24px' }}>
                          <div className="wiki-document-container">
                            {isEditingWiki ? (
                              <textarea
                                className="wiki-editor-textarea"
                                value={wikiEditContent}
                                onChange={(e) => setWikiEditContent(e.target.value)}
                                placeholder="编写 Markdown 内容..."
                              />
                            ) : (
                              <>
                                {activeWikiPage === 'index.md' && (
                                  <div className="bento-dashboard-grid">
                                    {/* Bento Card 1: Red Flag Alert */}
                                    <div className={`bento-card bento-red-flag ${selectedClient.allergies ? 'has-allergies' : ''}`}>
                                      <div className="bento-card-header-row">
                                        <div className="bento-card-title-group">
                                          <span className="material-symbols-outlined icon-fill bento-card-icon" style={{ color: selectedClient.allergies ? 'var(--color-error)' : 'var(--success)' }}>
                                            {selectedClient.allergies ? 'crisis_alert' : 'check_circle'}
                                          </span>
                                          <span className="bento-card-label" style={{ color: selectedClient.allergies ? 'var(--color-on-error-container)' : 'var(--success)' }}>
                                            {selectedClient.allergies ? '红旗警讯 / 过敏史' : '健康状态 / 无过敏'}
                                          </span>
                                        </div>
                                        <div className="bento-card-value-large" style={{ color: selectedClient.allergies ? 'var(--color-error)' : 'var(--success)' }}>
                                          {selectedClient.allergies ? '1' : '0'}
                                        </div>
                                      </div>
                                      <div className="bento-card-footer-text" style={{ 
                                        color: selectedClient.allergies ? 'var(--color-on-error-container)' : 'var(--text-secondary)',
                                        borderTop: selectedClient.allergies ? '1px solid rgba(147, 0, 10, 0.15)' : '1px solid var(--border-color)'
                                      }}>
                                        {selectedClient.allergies ? `警告: ${selectedClient.allergies}` : '暂无登记高危过敏或慢病红线'}
                                      </div>
                                    </div>

                                    {/* Bento Card 2: Severity Distribution */}
                                    <div className="bento-card bento-severity-distribution">
                                      <div className="bento-severity-content-row">
                                        {/* Conic donut ring */}
                                        <div className="bento-donut-container" style={{ 
                                          background: severityStats.noData
                                            ? 'conic-gradient(#e2e8f0 0% 100%)'
                                            : `conic-gradient(#ef4444 0% ${(severityStats.high / severityStats.total) * 100}%, #9a4500 ${(severityStats.high / severityStats.total) * 100}% ${((severityStats.high + severityStats.medium) / severityStats.total) * 100}%, #0052d9 ${((severityStats.high + severityStats.medium) / severityStats.total) * 100}% 100%)`
                                        }}>
                                          <div className="bento-donut-center">
                                            {severityStats.noData ? (
                                              <>
                                                <span className="bento-donut-number" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>待</span>
                                                <span className="bento-donut-label" style={{ color: 'var(--text-secondary)' }}>AI同步</span>
                                              </>
                                            ) : (
                                              <>
                                                <span className="bento-donut-number">{severityStats.total}</span>
                                                <span className="bento-donut-label">关注项</span>
                                              </>
                                            )}
                                          </div>
                                        </div>
                                        
                                        <div className="bento-severity-list">
                                          <span className="bento-card-label" style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>风险严重度分布</span>
                                          {severityStats.noData ? (
                                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                                              <div>⏳ 尚无AI分析数据</div>
                                              <div>点击「同步 Wiki」后</div>
                                              <div>严重度自动统计</div>
                                            </div>
                                          ) : (
                                            <>
                                              <div className="bento-severity-item">
                                                <div className="bento-severity-dot" style={{ background: '#ef4444' }}></div>
                                                <span style={{ color: 'var(--text-primary)' }}>高危关注 ({severityStats.high})</span>
                                              </div>
                                              <div className="bento-severity-item">
                                                <div className="bento-severity-dot" style={{ background: '#9a4500' }}></div>
                                                <span style={{ color: 'var(--text-primary)' }}>中危关注 ({severityStats.medium})</span>
                                              </div>
                                              <div className="bento-severity-item">
                                                <div className="bento-severity-dot" style={{ background: '#0052d9' }}></div>
                                                <span style={{ color: 'var(--text-primary)' }}>常规指标 ({severityStats.low})</span>
                                              </div>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                    </div>

                                    {/* Bento Card 3: AI Sync Tracker */}
                                    <div className="bento-card bento-ai-sync">
                                      <div className="bento-card-header-row">
                                        <div className="bento-card-title-group">
                                          <span className="material-symbols-outlined bento-card-icon" style={{ color: 'var(--primary)' }}>hub</span>
                                          <span className="bento-card-label" style={{ color: 'var(--text-muted)' }}>AI 置信度评估</span>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '2px' }}>
                                          <span className="bento-card-value-large" style={{ color: 'var(--primary)' }}>{syncStats.confidence}</span>
                                          <span style={{ fontSize: '12px', color: 'var(--primary)', fontWeight: '600' }}>%</span>
                                        </div>
                                      </div>
                                      <div className="bento-card-progress-container">
                                        <div className="bento-card-progress-label-row">
                                          <span>日志融入率 (已同步)</span>
                                          <span>{syncStats.syncedLogs} / {syncStats.total}</span>
                                        </div>
                                        <div className="bento-card-progress-bar-bg">
                                          <div className="bento-card-progress-bar-fill" style={{ width: `${syncStats.progress}%` }}></div>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                )}
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
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 右侧常驻双翼评估图面板 (方案 D) */}
                    <aside className="wiki-sidebar-map-wide">
                      <div className="map-header-bar">
                        <h3>🧍 脏器受损评估 <span className="layout-badge">Scheme D (580px)</span></h3>
                        <p>基于当前 Wiki 内容实时扫描，并在身体两侧左右分栏展示系统卡片</p>
                      </div>
                      <AnatomicalHealthMap markdownContent={wikiPages[activeWikiPage]} />
                    </aside>
                  </div>
                )}

                {/* 页签 2: 沟通记录 (高级 Timeline 组件) */}
                {activeTab === 'logs' && (
                  <div className="logs-workspace" style={{ padding: '24px 48px', height: '100%', overflowY: 'auto' }}>
                    <div className="logs-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                      <h3 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="material-symbols-outlined text-primary">timeline</span>
                        患者沟通接触史与诊断转录时间轴
                      </h3>
                      <button className="btn-primary" onClick={() => setShowLogModal(true)} style={{ borderRadius: '12px' }}>
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
                        录入新沟通记录
                      </button>
                    </div>

                    <div className="logs-timeline" style={{ position: 'relative', borderLeft: '2px solid var(--border-color)', marginLeft: '12px', display: 'flex', flexDirection: 'column', gap: '24px', paddingLeft: '24px', paddingBottom: '32px' }}>
                      {logs.length === 0 ? (
                        <div className="empty-logs" style={{ paddingLeft: '0', borderLeft: 'none' }}>
                          <p>暂无任何原始沟通记录</p>
                          <p className="subtext">请点击右上角录入第一条问诊转录或单证 OCR 记录</p>
                        </div>
                      ) : (
                        [...logs].reverse().map(log => {
                          const typeIcon = log.type === 'phone' ? 'phone_in_talk' :
                                           log.type === 'video' ? 'videocam' :
                                           log.type === 'wechat' ? 'forum' : 'description';
                          const typeLabel = log.type === 'phone' ? '电话问诊' :
                                            log.type === 'video' ? '视频问诊' :
                                            log.type === 'wechat' ? '企微随访' : '单证 OCR';
                          const dotColor = log.synced ? '#10b981' : '#f59e0b';
                          
                          return (
                            <div key={log.id} className="log-timeline-node" style={{ position: 'relative', width: '100%' }}>
                              {/* Status dot circle centered on left border */}
                              <div style={{ 
                                position: 'absolute', 
                                left: '-31px', 
                                top: '16px', 
                                width: '12px', 
                                height: '12px', 
                                borderRadius: '50%', 
                                background: dotColor, 
                                boxShadow: `0 0 0 4px #ffffff, 0 0 10px ${dotColor}`,
                                zIndex: 5
                              }}></div>
                              
                              <div 
                                className={`log-card ${!log.synced ? 'unsynced' : ''}`}
                                style={{ cursor: 'default' }}
                              >
                                <div className="log-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                                  <div className="log-type-tag" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span className={`type-badge type-${log.type}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '2px 8px', borderRadius: '6px', background: 'var(--color-surface-container-low)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                                      <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>{typeIcon}</span>
                                      {typeLabel}
                                    </span>
                                    <h4 className="log-title" style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>{log.title}</h4>
                                  </div>
                                  <div className="log-meta" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                    <span className="log-time" style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>{new Date(log.timestamp).toLocaleString()}</span>
                                    <span 
                                      className={`sync-badge ${log.synced ? 'synced' : 'pending'}`} 
                                      style={{ 
                                        fontSize: '11px', 
                                        padding: '2px 8px', 
                                        borderRadius: '20px', 
                                        background: log.synced ? 'rgba(0, 108, 71, 0.08)' : 'rgba(154, 69, 0, 0.08)', 
                                        border: log.synced ? '1px solid rgba(0, 108, 71, 0.2)' : '1px solid rgba(154, 69, 0, 0.2)',
                                        color: log.synced ? '#006c47' : '#9a4500'
                                      }}
                                    >
                                      {log.synced ? '● 已融入 Wiki' : '○ 待模型同步'}
                                    </span>
                                  </div>
                                </div>
                                <div className="log-card-body">
                                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordWrap: 'break-word', fontFamily: 'monospace', fontSize: '12.5px', color: 'var(--text-primary)', lineHeight: '1.6' }}>{log.content}</pre>
                                </div>
                              </div>
                            </div>
                          );
                        })
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
