import React, { useState, useEffect, useRef, useMemo } from 'react';
import { marked } from 'marked';
import { diffLines } from '../utils/diff';
import './HealthWikiRenderer.css';

export default function HealthWikiRenderer({
  markdownContent,
  prevMarkdownContent,
  showDiff,
  logSources = [],
  personMeta = null,
  onOpenReference,
  onSelectionAction,
  isIndexPage = false
}) {
  const containerRef = useRef(null);
  
  // ── 格式化思维导图叶子节点文本 ────────────────────
  const parseLeafNode = (nodeText) => {
    // 剔除 markdown 粗体标记
    const cleanText = nodeText.replace(/\*\*/g, '').trim();
    // 匹配英文冒号或中文冒号
    const colonIdx = cleanText.search(/[:：]/);
    if (colonIdx !== -1) {
      const label = cleanText.substring(0, colonIdx).trim();
      const value = cleanText.substring(colonIdx + 1).trim();
      return (
        <>
          <span className="leaf-label">{label}:</span>
          <span className="leaf-value"> {value}</span>
        </>
      );
    }
    return <span className="leaf-text">{cleanText}</span>;
  };

  // ── 状态管理 ─────────────────────────────────
  const [mindmapOpen, setMindmapOpen] = useState(false);
  const [popoverState, setPopoverState] = useState({
    visible: false,
    x: 0,
    y: 0,
    text: ''
  });
  const [aiResult, setAiResult] = useState({
    loading: false,
    content: '',
    visible: false
  });

  // ── 监听点击空白处关闭弹窗 ──────────────────────
  useEffect(() => {
    const handleDocumentClick = (e) => {
      // 点击外部时关闭划词气泡
      if (popoverState.visible && !e.target.closest('.selection-popover')) {
        setPopoverState(prev => ({ ...prev, visible: false }));
      }
      // 点击外部时关闭 AI 释义结果泡
      if (aiResult.visible && !e.target.closest('.ai-result-bubble') && !e.target.closest('.selection-popover')) {
        setAiResult(prev => ({ ...prev, visible: false }));
      }
    };
    document.addEventListener('mousedown', handleDocumentClick);
    return () => document.removeEventListener('mousedown', handleDocumentClick);
  }, [popoverState.visible, aiResult.visible]);

  // ── 鼠标选择文本事件 (划词) ──────────────────────
  const handleContainerMouseUp = (e) => {
    const selection = window.getSelection();
    if (!selection) return;
    
    const selectedText = selection.toString().trim();
    if (!selectedText) {
      return;
    }

    // 限制仅在 Wiki 渲染正文内的选择生效
    const range = selection.getRangeAt(0);
    if (!containerRef.current || !containerRef.current.contains(range.commonAncestorContainer)) {
      return;
    }

    // 获取选择区域的坐标包围盒
    const rects = range.getClientRects();
    if (rects.length === 0) return;

    const firstRect = rects[0];
    const containerRect = containerRef.current.getBoundingClientRect();

    // 计算相对于渲染容器的坐标 (气泡居中显示在选中文字上方)
    const relativeX = (firstRect.left + firstRect.right) / 2 - containerRect.left;
    const relativeY = firstRect.top - containerRect.top;

    setPopoverState({
      visible: true,
      x: relativeX,
      y: relativeY - 45, // 向上偏移 45 像素
      text: selectedText
    });
  };

  // ── 处理划词 AI 操作 ─────────────────────────
  const handlePopoverAction = async (actionType) => {
    const textToProcess = popoverState.text;
    setPopoverState(prev => ({ ...prev, visible: false }));
    
    setAiResult({
      loading: true,
      content: '',
      visible: true
    });

    try {
      if (onSelectionAction) {
        const response = await onSelectionAction(actionType, textToProcess);
        setAiResult({
          loading: false,
          content: response,
          visible: true
        });
      } else {
        // 兜底模拟回答
        setTimeout(() => {
          setAiResult({
            loading: false,
            content: `针对“${textToProcess}”的 AI 自动解读：该药属于常见心脑血管控制类药物，请严格遵医嘱服用。`,
            visible: true
          });
        }, 1200);
      }
    } catch (err) {
      setAiResult({
        loading: false,
        content: `调用 AI 服务出错，请检查接口配置。`,
        visible: true
      });
    }
  };

  // ── 编译并提取 Markdown 事实与元数据 ─────────────
  const { aiSummary, patientName, cleanedMarkdown, processedHtml, mindmapTree } = useMemo(() => {
    let raw = markdownContent || '# 页面为空\n点击右上角开始编辑。';
    
    // 1. 进行差异对比
    if (showDiff && prevMarkdownContent) {
      raw = diffLines(prevMarkdownContent, raw);
    }

    // 2. 提取患者名字 (解析第一个大标题，如 "# 客户健康首页：张三")
    let extractedName = personMeta?.name || '患者';
    const titleMatch = raw.match(/^#\s+(?:客户健康首页|既往史|用药方案|随访互动)[：:]\s*(.+)$/m);
    if (titleMatch) {
      extractedName = titleMatch[1].replace(/\[(.*?)\]\(.*?\)/g, '$1').trim();
    }

    // 3. 提取置顶的 AI 导读块 (支持注释、提示框或智能自动提取大纲)
    let extractedSummary = '';
    const summaryCommentMatch = raw.match(/<!--\s*SUMMARY_START\s*-->([\s\S]*?)<!--\s*SUMMARY_END\s*-->/);
    if (summaryCommentMatch) {
      extractedSummary = summaryCommentMatch[1].trim();
      raw = raw.replace(/<!--\s*SUMMARY_START\s*-->[\s\S]*?<!--\s*SUMMARY_END\s*-->/, '');
    } else {
      // 兼容非注释写法，查找首个提示框作为导读
      const noteMatch = raw.match(/>\s*\[!NOTE\]\s*[\n\r](?:>\s*\*\*AI\s*导读\*\*\s*[:：]?\s*[\n\r])?([\s\S]*?)(?=\n\n|\n[^>])/i);
      if (noteMatch) {
        extractedSummary = noteMatch[1].split('\n').map(line => line.replace(/^>\s?/, '')).join('\n').trim();
      }
    }

    // 智能回退：若未找到显式导读标记，自动从“红线警示”、“当前主要关注”及“健康主诉”中提取生成精炼导读
    if (!extractedSummary && isIndexPage) {
      const summaryItems = [];
      // 1. 提取红线警示
      const redlineMatch = raw.match(/>\s*\[!IMPORTANT\]\s*[\n\r]>\s*\*\*红线警示[^*]*\*\*[：:]\s*(.+)/);
      if (redlineMatch && redlineMatch[1] && !redlineMatch[1].includes('暂无') && !redlineMatch[1].includes('未登记')) {
        const cleanRedline = redlineMatch[1].replace(/\[🔗\s*溯源\]\([^)]+\)/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').trim();
        if (cleanRedline) summaryItems.push(`⚠️ 警示关注：${cleanRedline}`);
      }
      // 2. 提取当前主要关注
      const concernsMatch = raw.match(/##\s*1\.\s*当前主要关注[^\n]*\n([\s\S]*?)(?=\n##|$)/);
      if (concernsMatch) {
        const concernBullets = concernsMatch[1]
          .split('\n')
          .filter(l => l.trim().startsWith('*') || l.trim().startsWith('-'))
          .map(l => l.replace(/^[*-\s]+/, '').replace(/\[🔗\s*溯源\]\([^)]+\)/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').trim())
          .filter(l => l && !l.includes('暂无关注项') && !l.includes('暂无记录'));
        if (concernBullets.length > 0) {
          summaryItems.push(`📌 当前关注：${concernBullets.slice(0, 3).join('；')}`);
        }
      }
      // 3. 提取近期主要健康主诉
      const chiefComplaintMatch = raw.match(/\*+\s*\*\*近期主要健康主诉\*\*[：:]\s*(.+)/);
      if (chiefComplaintMatch && chiefComplaintMatch[1] && !chiefComplaintMatch[1].includes('暂无') && !chiefComplaintMatch[1].includes('待大模型')) {
        const cleanComplaint = chiefComplaintMatch[1].replace(/\[🔗\s*溯源\]\([^)]+\)/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').trim();
        if (cleanComplaint) summaryItems.push(`🩺 近期主诉：${cleanComplaint}`);
      }

      if (summaryItems.length > 0) {
        extractedSummary = summaryItems.join('\n');
      }
    }

    // 4. 解析标题层级，构建通用脑图结构树
    const tree = {
      root: extractedName,
      branches: []
    };
    
    const lines = raw.split('\n');
    let currentBranch = null;
    
    for (const line of lines) {
      // 匹配二级标题 (如 "## 1. 当前用药方案")
      const h2Match = line.match(/^##\s+(.+)$/);
      if (h2Match) {
        const title = h2Match[1].replace(/\[(.*?)\]\(.*?\)/g, '$1').trim();
        currentBranch = { title, nodes: [] };
        tree.branches.push(currentBranch);
        continue;
      }
      
      // 匹配三级标题或列表条目 (限制每个分支最多 4 个子节点，防止脑图过大)
      if (currentBranch && currentBranch.nodes.length < 4) {
        const listMatch = line.match(/^[-*]\s+(.+)$/);
        if (listMatch) {
          const itemText = listMatch[1]
            .replace(/\[(.*?)\]\(.*?\)/g, '$1') // 移除链接标记只显字
            .substring(0, 18) // 截断过长文字
            .trim();
          currentBranch.nodes.push(itemText);
        }
      }
    }
    
    // 如果没有二级标题，提供默认脑图框架
    if (tree.branches.length === 0) {
      tree.branches = [
        { title: '诊断与病史', nodes: ['高血压史', '水肿反应'] },
        { title: '用药指导', nodes: ['氨氯地平(晨)', '低盐饮食'] },
        { title: '近期动态', nodes: ['血压回落', '脚踝水肿'] }
      ];
    }

    // 4b. 解析结构化观察块与干预块 (Phase 2 & 3)
    let processedText = raw.replace(/```(observation|intervention)-block[\r\n]([\s\S]*?)```/g, (match, blockType, blockContent) => {
      try {
        const lines = blockContent.split('\n');
        const data = {};
        lines.forEach(line => {
          const idx = line.indexOf(':');
          if (idx !== -1) {
            const key = line.substring(0, idx).trim();
            let value = line.substring(idx + 1).trim();
            if (value.startsWith('"') && value.endsWith('"')) {
              value = value.substring(1, value.length - 1);
            } else if (value.startsWith("'") && value.endsWith("'")) {
              value = value.substring(1, value.length - 1);
            }
            data[key] = value;
          }
        });

        // 提取 evidence_refs 数组
        const evidenceRefs = [];
        let parsingRefs = false;
        lines.forEach(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith('evidence_refs:')) {
            parsingRefs = true;
          } else if (parsingRefs) {
            if (trimmed.startsWith('-')) {
              const ref = trimmed.substring(1).trim().replace(/['"]/g, '');
              if (ref) evidenceRefs.push(ref);
            } else if (trimmed.includes(':')) {
              parsingRefs = false;
            }
          }
        });

        if (!data.content) {
          throw new Error('Missing required field: content');
        }
        const content = data.content;
        const subtype = data.subtype || '';
        const score = data.attention_score ? parseFloat(data.attention_score) : null;

        const citations = evidenceRefs.map(ref => 
          `<span class="ref-citation-badge" data-log-id="${ref}">🔗 溯源</span>`
        ).join(' ');

        if (blockType === 'observation') {
          let glowClass = 'attention-normal';
          let badgeText = '常规观察';
          if (score !== null) {
            if (score >= 0.8) {
              glowClass = 'attention-high';
              badgeText = '🚨 高危关注';
            } else if (score >= 0.5) {
              glowClass = 'attention-medium';
              badgeText = '⚠️ 中危关注';
            }
          }
          const scoreBadgeHtml = score !== null ? `<span class="score-badge ${glowClass}-badge">${badgeText} (${score})</span>` : '';
          return `<div class="structured-block-card observation-card ${glowClass}-card" style="border-radius: 16px; margin: 16px 0; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.05); background: rgba(30, 41, 59, 0.45); transition: all 0.2s ease;">
            <div class="card-header" style="display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <span class="material-symbols-outlined icon-fill" style="font-size: 16px; color: var(--text-secondary);">visibility</span>
              <strong class="card-title" style="font-size: 13px; font-weight: 600; color: var(--text-primary);">观察 / ${subtype}</strong>
              ${scoreBadgeHtml}
            </div>
            <div class="card-body" style="padding: 16px; font-size: 13.5px; color: var(--text-primary); line-height: 1.6;">
              <span class="card-content-text" style="font-weight: 500; display: block; margin-bottom: 10px;">${content}</span>
              <div class="card-footer-badges" style="display: flex; gap: 8px; border-top: 1px dashed rgba(255, 255, 255, 0.05); padding-top: 8px; align-items: center; flex-wrap: wrap;">
                <span class="card-origin-badge" style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 6px; padding: 2px 8px; font-size: 11px; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 4px;">
                  <span class="material-symbols-outlined" style="font-size: 12px; color: var(--text-secondary);">database</span>
                  数据证据
                </span>
                ${citations}
              </div>
            </div>
          </div>`;
        } else {
          return `<div class="structured-block-card intervention-card" style="border-radius: 16px; margin: 16px 0; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.05); background: rgba(30, 41, 59, 0.45); transition: all 0.2s ease;">
            <div class="card-header" style="display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
              <span class="material-symbols-outlined icon-fill" style="font-size: 16px; color: var(--text-secondary);">healing</span>
              <strong class="card-title" style="font-size: 13px; font-weight: 600; color: var(--text-primary);">干预 / ${subtype}</strong>
            </div>
            <div class="card-body" style="padding: 16px; font-size: 13.5px; color: var(--text-primary); line-height: 1.6;">
              <span class="card-content-text" style="font-weight: 500; display: block; margin-bottom: 10px;">${content}</span>
              <div class="card-footer-badges" style="display: flex; gap: 8px; border-top: 1px dashed rgba(255, 255, 255, 0.05); padding-top: 8px; align-items: center; flex-wrap: wrap;">
                <span class="card-origin-badge" style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 6px; padding: 2px 8px; font-size: 11px; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 4px;">
                  <span class="material-symbols-outlined" style="font-size: 12px; color: var(--text-secondary);">medical_services</span>
                  干预治疗
                </span>
                ${citations}
              </div>
            </div>
          </div>`;
        }
      } catch (err) {
        console.error("YAML parsing fallback triggered:", err);
        // 负面测试兜底：若 YAML 解析损坏，优雅降级渲染而不崩溃
        return `<div class="alert-block alert-note"><strong>📋 结构化数据异常</strong><p>${blockContent.split('\n').join('<br/>')}</p></div>`;
      }
    });

    // 5. 将医疗警告编译为高度定制的 CSS Block 元素
    // 正则匹配并替换 > [!IMPORTANT] 等语法
    let compiledText = processedText.replace(/>\s*\[!(IMPORTANT|WARNING|TIP|NOTE)\][\r\n]([\s\S]*?)(?=\n\n|\n[^>])/g, (match, type, content) => {
      const cleanContent = content.split('\n').map(line => line.replace(/^>\s?/, '')).join('<br/>');
      const label = type === 'IMPORTANT' ? '🚨 医疗红线与过敏史' : 
                    type === 'WARNING' ? '⚠️ 指标异常与警示' : 
                    type === 'TIP' ? '💡 康复随访与生活医嘱' : '📋 核心健康备注';
      return `<div class="alert-block alert-${type.toLowerCase()}"><strong>${label}</strong><p>${cleanContent}</p></div>`;
    });

    // 6. 自动匹配 [🔗 溯源](log_xxx) 标签并转化为定制 Span 徽章
    // 例如支持 Markdown: [🔗 溯源](log_1779347385975_0)
    compiledText = compiledText.replace(/\[🔗\s*溯源\]\((.*?)\)/g, (match, logId) => {
      return `<span class="ref-citation-badge" data-log-id="${logId}">🔗 溯源</span>`;
    });

    // 7. 处理增量高亮 Diff 标记
    compiledText = compiledText.replace(/<p>\s*<diff-added-block>\s*<\/p>/g, '<diff-added-block>');
    compiledText = compiledText.replace(/<p>\s*<\/diff-added-block>\s*<\/p>/g, '</diff-added-block>');
    compiledText = compiledText.replace(/<diff-added-block>/g, '<div class="diff-added">');
    compiledText = compiledText.replace(/<\/diff-added-block>/g, '</div>');

    // 8. 解析为 HTML
    const processedHtml = marked.parse(compiledText);

    return {
      aiSummary: extractedSummary || (isIndexPage ? '大模型正在提取健康事件大纲...' : null),
      patientName: extractedName,
      cleanedMarkdown: compiledText,
      processedHtml,
      mindmapTree: tree
    };
  }, [markdownContent, prevMarkdownContent, showDiff, personMeta, isIndexPage]);

  // ── 拦截链接点击事件实现原文对照 ───────────────────
  const handleHtmlClick = (e) => {
    // 拦截溯源小角标的点击
    const citation = e.target.closest('.ref-citation-badge');
    if (citation) {
      e.preventDefault();
      const logId = citation.getAttribute('data-log-id');
      if (onOpenReference && logId) {
        onOpenReference(logId);
      }
      return;
    }

    // 拦截普通 Wiki 页面跳转
    const link = e.target.closest('a');
    if (link) {
      const href = link.getAttribute('href');
      // 如果是本站 Wiki 内联跳转
      if (href && href.endsWith('.md') && !href.startsWith('http')) {
        // 在 App 中切换 Wiki 页面 (此处让原 App.jsx 里的 linkClick 委托去处理，或者由我们代理后抛出)
      }
    }
  };

  // ── 点击脑图节点滚动定位 ────────────────────────
  const handleMindmapNodeClick = (nodeText) => {
    if (!containerRef.current) return;
    
    // 模糊查找正文中的对应标题段落
    const headings = containerRef.current.querySelectorAll('h2, h3, li, strong');
    for (const el of headings) {
      if (el.textContent.includes(nodeText)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // 施加短暂高亮动效
        el.style.backgroundColor = '#fef08a';
        setTimeout(() => {
          el.style.backgroundColor = '';
        }, 1200);
        break;
      }
    }
  };

  return (
    <div className="wiki-rendered-view" ref={containerRef} onMouseUp={handleContainerMouseUp}>
      
      {/* 1. 置顶 🪄 AI 导读速览卡片 */}
      {aiSummary && (
        <div className="ai-summary-card">
          <div className="ai-summary-header">
            <span className="ai-summary-sparkle">🪄</span>
            <span>AI 健康导读速览 ({patientName})</span>
          </div>
          <div className="ai-summary-content">
            {aiSummary.split('\n').map((line, idx) => (
              <div key={idx}>{line}</div>
            ))}
          </div>
        </div>
      )}

      {/* 2. 交互式健康逻辑思维脑图模块 */}
      <div className="wiki-mindmap-section">
        <div className="wiki-mindmap-header" onClick={() => setMindmapOpen(!mindmapOpen)} style={{ cursor: 'pointer' }}>
          <div className="mindmap-header-left" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>🧠 交互式健康逻辑思维脑图</span>
          </div>
          <div className="mindmap-header-controls" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span 
              style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)' }}
            >
              {mindmapOpen ? '收起 ▲' : '展开 ▼'}
            </span>
          </div>
        </div>
        
        {mindmapOpen && (
          <div className="wiki-mindmap-container">
            <div className="mindmap-tree">
              {/* 根节点列 */}
              <div className="mindmap-root-col">
                <div className="mindmap-root-node">👤 {mindmapTree.root}</div>
              </div>
              
              {/* 各级分支列 */}
              <div className="mindmap-branches-col">
                {mindmapTree.branches.map((branch, bIdx) => (
                  <div className="mindmap-branch-row" key={bIdx}>
                    {/* 分支标题包装器 */}
                    <div className="mindmap-branch-node-wrapper">
                      <div 
                        className="mindmap-branch-node" 
                        onClick={() => handleMindmapNodeClick(branch.title)}
                      >
                        📂 {branch.title}
                      </div>
                    </div>
                    {/* 叶节点包装列 */}
                    <div className="mindmap-leaves-col">
                      {branch.nodes.map((node, nIdx) => (
                        <div 
                          className="mindmap-leaf-node" 
                          key={nIdx}
                          onClick={() => handleMindmapNodeClick(node)}
                        >
                          <span className="leaf-icon">📄</span>
                          {parseLeafNode(node)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 3. 增强 Markdown 渲染主体 */}
      <div 
        className="markdown-rendered"
        onClick={handleHtmlClick}
        dangerouslySetInnerHTML={{ __html: processedHtml }}
      />

      {/* 4. 划词 AI 伴随悬浮气泡菜单 */}
      {popoverState.visible && (
        <div 
          className="selection-popover"
          style={{ left: `${popoverState.x}px`, top: `${popoverState.y}px` }}
        >
          <button className="popover-btn primary" onClick={() => handlePopoverAction('explain')}>
            🔍 AI 解释
          </button>
          <button className="popover-btn" onClick={() => handlePopoverAction('contraindication')}>
            💊 查配伍禁忌
          </button>
          <button className="popover-btn" onClick={() => handlePopoverAction('trace')}>
            🔗 关联溯源
          </button>
        </div>
      )}

      {/* 5. 气泡 AI 打字机解析结果泡 */}
      {aiResult.visible && (
        <div 
          className="ai-result-bubble"
          style={{
            position: 'absolute',
            left: `${popoverState.x}px`,
            top: `${popoverState.y + 45}px`,
            zIndex: 1001,
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '8px',
            padding: '12px 16px',
            maxWidth: '320px',
            boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
            fontSize: '0.85rem',
            lineHeight: '1.5',
            color: '#334155'
          }}
        >
          <div style={{ fontWeight: '700', marginBottom: '6px', color: '#2563eb', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span>🪄 AI 诊断回复:</span>
            {aiResult.loading && <div className="popover-loading-spinner" />}
          </div>
          <div>
            {aiResult.loading ? '正在调阅大模型...' : aiResult.content}
          </div>
        </div>
      )}
    </div>
  );
}
