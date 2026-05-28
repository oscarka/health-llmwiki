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
  onSelectionAction
}) {
  const containerRef = useRef(null);
  
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

    // 3. 提取置顶的 AI 导读块 (支持以注释 <!-- SUMMARY_START -->...<!-- SUMMARY_END --> 包裹的区块)
    let extractedSummary = '';
    const summaryCommentMatch = raw.match(/<!--\s*SUMMARY_START\s*-->([\s\S]*?)<!--\s*SUMMARY_END\s*-->/);
    if (summaryCommentMatch) {
      extractedSummary = summaryCommentMatch[1].trim();
      // 在正文中抹除导读注释，防止二次渲染
      raw = raw.replace(/<!--\s*SUMMARY_START\s*-->[\s\S]*?<!--\s*SUMMARY_END\s*-->/, '');
    } else {
      // 兼容非注释写法，查找首个提示框作为导读
      const noteMatch = raw.match(/>\s*\[!NOTE\]\s*[\n\r](?:>\s*\*\*AI\s*导读\*\*\s*[:：]?\s*[\n\r])?([\s\S]*?)(?=\n\n|\n[^>])/i);
      if (noteMatch) {
        extractedSummary = noteMatch[1].split('\n').map(line => line.replace(/^>\s?/, '')).join('\n').trim();
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

    // 5. 将医疗警告编译为高度定制的 CSS Block 元素
    // 正则匹配并替换 > [!IMPORTANT] 等语法
    let compiledText = raw.replace(/>\s*\[!(IMPORTANT|WARNING|TIP|NOTE)\][\r\n]([\s\S]*?)(?=\n\n|\n[^>])/g, (match, type, content) => {
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
      aiSummary: extractedSummary || '大模型正在提取健康事件大纲...',
      patientName: extractedName,
      cleanedMarkdown: compiledText,
      processedHtml,
      mindmapTree: tree
    };
  }, [markdownContent, prevMarkdownContent, showDiff, personMeta]);

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

      {/* 2. 交互式脑图思维导图模块 */}
      <div className="wiki-mindmap-section">
        <div className="wiki-mindmap-header" onClick={() => setMindmapOpen(!mindmapOpen)}>
          <span>🧠 交互式健康逻辑思维脑图</span>
          <span>{mindmapOpen ? '收起 ▲' : '展开 ▼'}</span>
        </div>
        
        {mindmapOpen && (
          <div className="wiki-mindmap-container">
            <div className="mindmap-tree">
              {/* 根节点 */}
              <div className="mindmap-root-node">👤 {mindmapTree.root}</div>
              
              {/* 各级分支 */}
              <div className="mindmap-branches">
                {mindmapTree.branches.map((branch, bIdx) => (
                  <div className="mindmap-branch-column" key={bIdx}>
                    {/* 分支标题 */}
                    <div 
                      className="mindmap-branch-node" 
                      onClick={() => handleMindmapNodeClick(branch.title)}
                    >
                      📂 {branch.title}
                    </div>
                    {/* 分支叶节点 */}
                    {branch.nodes.map((node, nIdx) => (
                      <div 
                        className="mindmap-branch-node" 
                        key={nIdx}
                        style={{ backgroundColor: '#ffffff', color: '#475569', borderStyle: 'solid' }}
                        onClick={() => handleMindmapNodeClick(node)}
                      >
                        📄 {node}
                      </div>
                    ))}
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
