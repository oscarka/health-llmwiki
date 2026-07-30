import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import './AnatomicalHealthMap.css';

// ─── 器官定义 (以裁剪后的 viewBox: 125 140 210 945 为基准的精确百分比坐标) ────────
const ORGAN_DEFS = [
  {
    id: 'brain',
    name: '脑部与神经',
    icon: '🧠',
    pctX: 50, pctY: 6, // 头部中心
    side: 'left',
    keywords: ['脑', '意识', '神志', '认知', '昏迷', '嗜睡', '失语', '偏瘫', '肌力', '瞳孔', '头晕', '头痛', '神经', '癫痫', '植物神经', 'HRV'],
  },
  {
    id: 'lungs',
    name: '肺部与呼吸',
    icon: '🫁',
    pctX: 43, pctY: 25, // 胸部左侧肺叶（观众视角左侧，患者右侧）
    side: 'left',
    keywords: ['肺', '呼吸', '血氧', 'spo2', 'SpO2', '咳嗽', '咳痰', '喘', '吸氧', '雾化', '哮喘', '慢阻肺', '肺炎', '气促', '气管'],
  },
  {
    id: 'heart',
    name: '心脏与循环',
    icon: '🫀',
    pctX: 51, pctY: 27, // 胸部中心偏下
    side: 'left',
    keywords: ['心', '脉搏', '血压', 'bp', 'BP', '胸闷', '心率', '冠心病', '房颤', '心梗', '心衰', '心跳', '高血压'],
  },
  {
    id: 'liver',
    name: '消化与胃肠',
    icon: '🫘',
    pctX: 58, pctY: 35, // 腹部右侧肝脏（观众视角右侧，患者左侧）
    side: 'right',
    keywords: ['肝', '胃', '胆', '肠', '吐', '呕', '便', '消化', '食欲', '便秘', '腹泻', '腹痛', '胰腺炎', '克罗恩', '胃管', '大便'],
  },
  {
    id: 'pancreas',
    name: '胰腺与血糖',
    icon: '🩸',
    pctX: 50, pctY: 38, // 胃部下方的胰腺（居中）
    side: 'right',
    keywords: ['血糖', '胰', '糖尿病', '尿糖', '糖化', '空腹血糖', '餐后血糖', 'HbA1c', '控糖'],
  },
  {
    id: 'kidneys',
    name: '肾脏与泌尿',
    icon: '🚽',
    pctX: 47, pctY: 43, // 肾脏与膀胱区域
    side: 'right',
    keywords: ['肾', '尿', '输尿管', '膀胱', '留置导尿', '尿管', '肌酐', '尿酸'],
  },
  {
    id: 'spine',
    name: '脊柱与骨骼',
    icon: '🦴',
    pctX: 50, pctY: 35, // 脊柱中轴线位置
    side: 'left',
    keywords: ['骨', '脊柱', '椎', '骨折', '腰', '骨质', '股骨', '关节', '髋部', 'L2', '颈椎', '腰椎', '压缩', '摔伤'],
  },
  {
    id: 'limbs',
    name: '四肢与运动',
    icon: '🦵',
    pctX: 42, pctY: 74, // 膝盖与关节下肢位置
    side: 'left',
    keywords: ['四肢', '下肢', '上肢', '翻身', '卧床', '活动障碍', '肢体', '膝', '足', '行走', '步态', '肌力', '步数'],
  },
];

const SYSTEMIC_DEFS = [
  {
    id: 'infectious',
    name: '传染与病毒',
    icon: '🦠',
    pctX: 70, pctY: 25, // 身体右侧表皮
    side: 'right',
    keywords: ['乙肝', '丙肝', '梅毒', '结核', '流感', '新冠', '隔离', '阳性', '感染', '传染', '带状疱疹', 'HIV'],
  },
  {
    id: 'allergy',
    name: '过敏与免疫',
    icon: '🌟',
    pctX: 30, pctY: 25, // 身体左侧表皮
    side: 'left',
    keywords: ['过敏', '青霉素', '红斑狼疮', '风湿', '痛风', '免疫', '皮疹', '荨麻疹', '药物过敏'],
  },
  {
    id: 'genetic',
    name: '遗传与家族',
    icon: '🧬',
    pctX: 50, pctY: 92, // 脚底生命线
    side: 'right',
    keywords: ['遗传', '家族史', '先天', '地中海贫血', '血友病', '染色体', '基因', '家族'],
  },
];

// 色阶配置
const SEVERITY = {
  high:   { label: '🔴 严重', class: 'sev-high',   color: '#ef4444' },
  medium: { label: '🟡 异常', class: 'sev-medium', color: '#f59e0b' },
  low:    { label: '🔵 轻微', class: 'sev-low',    color: '#3b82f6' },
};

function getSeverity(score) {
  if (score >= 0.75) return SEVERITY.high;
  if (score >= 0.45) return SEVERITY.medium;
  return SEVERITY.low;
}

// ─── 动态自然语言扫描器 ──────────────────────────────────────────────────────
function extractDynamicObservations(markdownContent) {
  if (!markdownContent) return [];
  
  // 1. 将 markdown 按行切割
  const lines = markdownContent.split('\n');
  const allDefs = [...ORGAN_DEFS, ...SYSTEMIC_DEFS];
  
  // 用于收集每个器官匹配到的观察事实
  const organMatches = {};
  allDefs.forEach(def => {
    organMatches[def.id] = {
      def,
      lines: new Set(),
      maxScore: 0.3 // 默认起始轻微受损分值
    };
  });

  lines.forEach(rawLine => {
    const cleanLine = rawLine.trim();
    if (!cleanLine) return;
    
    // 排除大标题、快捷导航等非实质观察叙述的 markdown 语法
    if (cleanLine.startsWith('#')) return;
    if (cleanLine.includes('快捷导航') || cleanLine.includes('.md)')) return;
    if (cleanLine.startsWith('* [') && cleanLine.includes('](')) return;
    
    // 将整行文本按标点符号（包含中英文逗号）拆分为独立的“句子”进行细粒度扫描，使卡片内容更精简聚焦
    const sentences = cleanLine.split(/[。！；？，,;!?\n]/);
    
    sentences.forEach(sentence => {
      let cleanSentence = sentence.trim();
      // 去除开头的 markdown 列表符号如 -, *, +, •, 数字点等
      cleanSentence = cleanSentence.replace(/^[\s-*•+]*\d*\.?\s*/, '');
      
      // 清洗 Markdown 的加粗符号、提示警示标识、负斜杠、溯源角标等
      cleanSentence = cleanSentence
        .replace(/\*\*/g, '')
        .replace(/\[!(IMPORTANT|WARNING|TIP|NOTE|CAUTION)\]/g, '')
        .replace(/>\s*/g, '')
        .replace(/\[🔗\s*溯源\]\((.*?)\)/g, '')
        .trim();
        
      if (cleanSentence.length < 4) return; // 太短的句子没有实际临床观察价值
      
      // 将此句子与器官分类的关键字逐一匹配
      allDefs.forEach(def => {
        const hasKeyword = def.keywords.some(kw => {
          if (kw === '尿') {
            // 排除“糖尿病”和“尿糖”以避免混淆胰腺代谢与肾脏泌尿系统
            return cleanSentence.includes('尿') && !cleanSentence.includes('糖尿病') && !cleanSentence.includes('尿糖');
          }
          return cleanSentence.toLowerCase().includes(kw.toLowerCase());
        });
        if (hasKeyword) {
          // 句子长度截断限制为 26 个字符，确保卡片紧凑整齐
          let displayText = cleanSentence;
          if (displayText.length > 26) {
            displayText = displayText.substring(0, 24) + '...';
          }
          
          organMatches[def.id].lines.add(displayText);
          
          // 3. 动态评分模型：基于特定的医疗“强预警词”调节严重程度分值
          let lineScore = 0.3; // 默认常规
          const textLower = cleanSentence.toLowerCase();
          
          if (
            textLower.includes('严重') || 
            textLower.includes('红线') || 
            textLower.includes('危及') || 
            textLower.includes('致命') || 
            textLower.includes('重度') || 
            textLower.includes('昏迷') || 
            textLower.includes('骨折') || 
            textLower.includes('肌力0级') || 
            textLower.includes('呼吸急促')
          ) {
            lineScore = 0.85; // 严重
          } else if (
            textLower.includes('警告') || 
            textLower.includes('异常') || 
            textLower.includes('低血氧') || 
            textLower.includes('糖尿病') || 
            textLower.includes('失调') || 
            textLower.includes('波动') || 
            textLower.includes('控制')
          ) {
            lineScore = 0.6; // 异常
          }
          
          if (lineScore > organMatches[def.id].maxScore) {
            organMatches[def.id].maxScore = lineScore;
          }
        }
      });
    });
  });

  // 4. 将收集结果组装成 activeOrgans 数组
  const activeOrgans = [];
  allDefs.forEach(def => {
    const match = organMatches[def.id];
    if (match.lines.size > 0) {
      // 提取前 2 条最相关的匹配行进行卡片展示
      const list = Array.from(match.lines).slice(0, 2).map(txt => ({
        content: txt,
        score: match.maxScore
      }));
      
      activeOrgans.push({
        ...def,
        score: match.maxScore,
        observations: list
      });
    }
  });

  return activeOrgans;
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────
export default function AnatomicalHealthMap({ markdownContent }) {
  const containerRef = useRef(null);
  const bodyWrapperRef = useRef(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [connectors, setConnectors] = useState([]);
  const [svgContent, setSvgContent] = useState('');

  // 异步加载 Wikipedia 的 organs.svg 文件并动态裁剪 viewBox
  useEffect(() => {
    fetch('/organs.svg')
      .then(res => res.text())
      .then(text => {
        let cleanSvg = text.replace(/<\?xml[^>]*\?>/i, '').replace(/<!DOCTYPE[^>]*>/i, '');
        
        // 动态强力重写 viewBox 属性，并清理 width/height 属性以保证响应式铺满容器
        cleanSvg = cleanSvg.replace(/<svg([^>]*)(?:viewBox="[^"]*")?([^>]*)>/i, (match, before, after) => {
          const cleanBefore = before.replace(/\b(width|height)="[^"]*"/gi, '');
          const cleanAfter = after.replace(/\b(width|height)="[^"]*"/gi, '');
          return `<svg ${cleanBefore} viewBox="125 140 210 945" style="width: 100%; height: 100%; display: block;" ${cleanAfter}>`;
        });

        setSvgContent(cleanSvg);
      })
      .catch(err => {
        console.error('Failed to load Wikipedia SVG:', err);
      });
  }, []);

  // 使用动态自然语言扫描器，而非硬编码 YAML
  const activeOrgans = useMemo(() => {
    return extractDynamicObservations(markdownContent);
  }, [markdownContent]);

  const leftOrgans  = activeOrgans.filter(o => o.side === 'left');
  const rightOrgans = activeOrgans.filter(o => o.side === 'right');

  // 计算连接引线 (从热点叠加坐标到卡片边缘)
  const recalcConnectors = () => {
    if (!containerRef.current || !bodyWrapperRef.current) return;
    const container = containerRef.current;
    
    // 动态将 SVG Canvas DOM 尺寸延伸至容器 scroll 范围，确保 1:1 像素精确映射
    const svgCanvas = container.querySelector('#connectorCanvas');
    if (svgCanvas) {
      svgCanvas.setAttribute('width', container.scrollWidth);
      svgCanvas.setAttribute('height', container.scrollHeight);
    }

    const containerRect = container.getBoundingClientRect();
    const bodyRect = bodyWrapperRef.current.getBoundingClientRect();
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;

    const newConn = [];
    activeOrgans.forEach(organ => {
      const cardEl = container.querySelector(`.organ-card[data-id="${organ.id}"]`);
      if (!cardEl) return;
      const cardRect = cardEl.getBoundingClientRect();

      // 根据百分比计算热点在容器内的绝对坐标，并融入滚动条的偏移
      const hotX = bodyRect.left - containerRect.left + scrollLeft + (organ.pctX / 100) * bodyRect.width;
      const hotY = bodyRect.top  - containerRect.top  + scrollTop  + (organ.pctY / 100) * bodyRect.height;

      let x2, y2;
      if (organ.side === 'left') {
        x2 = cardRect.right - containerRect.left + scrollLeft;
        y2 = cardRect.top - containerRect.top + scrollTop + cardRect.height / 2;
      } else {
        x2 = cardRect.left - containerRect.left + scrollLeft;
        y2 = cardRect.top - containerRect.top + scrollTop + cardRect.height / 2;
      }

      const dx = Math.abs(x2 - hotX) * 0.5;
      const cx1 = organ.side === 'left' ? hotX - dx : hotX + dx;
      const cx2 = organ.side === 'left' ? x2 + dx   : x2 - dx;

      newConn.push({
        id: organ.id,
        d: `M ${hotX} ${hotY} C ${cx1} ${hotY}, ${cx2} ${y2}, ${x2} ${y2}`,
        score: organ.score,
        hotX, hotY,
      });
    });
    setConnectors(newConn);
  };

  useLayoutEffect(() => {
    recalcConnectors();
    const t = setTimeout(recalcConnectors, 200);
    window.addEventListener('resize', recalcConnectors);
    
    const container = containerRef.current;
    if (container) {
      container.addEventListener('scroll', recalcConnectors);
    }
    
    return () => { 
      clearTimeout(t); 
      window.removeEventListener('resize', recalcConnectors); 
      if (container) {
        container.removeEventListener('scroll', recalcConnectors);
      }
    };
  }, [activeOrgans, svgContent]);

  return (
    <div className="amap-layout-container" ref={containerRef}>

      {activeOrgans.length === 0 && (
        <div className="amap-demo-notice">
          ℹ️ 暂未在当前 Wiki 页面中检测到相关的受损器官或生理信号指标。
        </div>
      )}

      {/* ── 左翼卡片列 ── */}
      <div className="amap-cards-column left-side">
        {leftOrgans.map(organ => (
          <OrganCard
            key={organ.id}
            organ={organ}
            hovered={hoveredId === organ.id}
            onHover={setHoveredId}
          />
        ))}
        {leftOrgans.length === 0 && <EmptyCol label="左翼系统正常" />}
      </div>

      {/* ── 中间人体 SVG 图 ── */}
      <div 
        ref={bodyWrapperRef} 
        className="amap-body-svg-wrapper"
        id="svgBodyWrapper"
      >
        <div 
          className="amap-svg-inner"
          dangerouslySetInnerHTML={{ __html: svgContent }}
          style={{ width: '100%', height: '100%' }}
        />

        {/* 动态覆盖在 SVG 内部范围的热点标记，使用 100% 相对定位 */}
        {activeOrgans.map(organ => {
          const sev = getSeverity(organ.score);
          const isHov = hoveredId === organ.id;
          return (
            <div
              key={organ.id}
              className={`hotspot ${sev.class} ${isHov ? 'active-hover' : ''}`}
              style={{
                position: 'absolute',
                left: `${organ.pctX}%`,
                top: `${organ.pctY}%`,
                transform: 'translate(-50%, -50%)',
                zIndex: 15,
                cursor: 'pointer'
              }}
              onMouseEnter={() => setHoveredId(organ.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {/* 中心点 */}
              <div className="hotspot-center" />
              {/* 呼吸外环 */}
              <div className="hotspot-ring" />
              {/* 气泡标签 */}
              <div className="hotspot-label">{organ.icon} {organ.name.split('与')[0]}</div>
            </div>
          );
        })}
      </div>

      {/* ── 右翼卡片列 ── */}
      <div className="amap-cards-column right-side">
        {rightOrgans.map(organ => (
          <OrganCard
            key={organ.id}
            organ={organ}
            hovered={hoveredId === organ.id}
            onHover={setHoveredId}
          />
        ))}
        {rightOrgans.length === 0 && <EmptyCol label="右翼系统正常" />}
      </div>

      {/* ── 全局连接线 SVG Canvas ── */}
      <svg className="amap-connector-canvas" id="connectorCanvas" style={{ position:'absolute', top:0, left:0, width:'100%', height:'100%', pointerEvents:'none', zIndex:5 }}>
        {connectors.map(conn => {
          const organ = activeOrgans.find(o => o.id === conn.id);
          if (!organ) return null;
          const sev = getSeverity(organ.score);
          const isHov = hoveredId === conn.id;
          return (
            <g key={conn.id}>
              {/* 发光底层 */}
              <path d={conn.d} fill="none"
                stroke={sev.color}
                strokeWidth={isHov ? 5 : 2.5}
                opacity={isHov ? 0.25 : 0.1}
                strokeLinecap="round"
              />
              {/* 主线 */}
              <path d={conn.d} fill="none"
                stroke={sev.color}
                strokeWidth={isHov ? 2 : 1.2}
                strokeDasharray={isHov ? 'none' : '4 3'}
                opacity={isHov ? 1 : 0.6}
                strokeLinecap="round"
                className={isHov ? 'conn-active' : ''}
              />
              {/* 连接点 */}
              <circle cx={conn.hotX} cy={conn.hotY} r={isHov ? 4 : 3}
                fill={sev.color}
                opacity={isHov ? 1 : 0.8}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── 器官信息卡片 ──────────────────────────────────────────────────────────────
function OrganCard({ organ, hovered, onHover }) {
  const sev = getSeverity(organ.score);
  return (
    <div
      className={`organ-card ${sev.class} ${hovered ? 'hovered' : ''}`}
      data-id={organ.id}
      onMouseEnter={() => onHover(organ.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="organ-card-header">
        <span className="organ-card-title">
          <span className="organ-icon">{organ.icon}</span>
          {organ.name}
        </span>
        <span className={`sev-badge ${sev.class}-badge`}>{sev.label}</span>
      </div>
      <div className="organ-card-body">
        {organ.observations.map((ob, i) => (
          <div className="obs-item" key={i}>
            <span className="obs-bullet" style={{ color: sev.color }}>▸</span>
            <span className="obs-text">{ob.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyCol({ label }) {
  return (
    <div className="amap-empty-col">
      <span>✓ {label}</span>
    </div>
  );
}
