import React, { useState, useEffect, useMemo, useRef } from 'react';
import './AnatomicalHealthMap.css';

// ─── 器官与系统定义 (基于 Wikipedia organs.svg viewBox: 125 140 210 945 精确坐标) ───
const ORGAN_DEFS = [
  {
    id: 'brain',
    name: '脑部与神经',
    icon: '🧠',
    pctX: 50, pctY: 7, // 头部中枢
    side: 'left',
    keywords: ['脑', '意识', '神志', '认知', '昏迷', '嗜睡', '失语', '偏瘫', '肌力', '瞳孔', '头晕', '头痛', '神经', '癫痫', '植物神经', 'HRV'],
  },
  {
    id: 'lungs',
    name: '肺部与呼吸',
    icon: '🫁',
    pctX: 43, pctY: 25, // 胸部肺叶
    side: 'left',
    keywords: ['肺', '呼吸', '血氧', 'spo2', 'SpO2', '咳嗽', '咳痰', '喘', '吸氧', '雾化', '哮喘', '慢阻肺', '肺炎', '气促', '气管'],
  },
  {
    id: 'heart',
    name: '心脏与循环',
    icon: '🫀',
    pctX: 53, pctY: 27, // 胸部心脏偏左
    side: 'left',
    keywords: ['心', '脉搏', '血压', 'bp', 'BP', '胸闷', '心率', '冠心病', '房颤', '心梗', '心衰', '心跳', '高血压'],
  },
  {
    id: 'liver',
    name: '消化与胃肠',
    icon: '🫘',
    pctX: 57, pctY: 35, // 肝脏与胃肠消化道
    side: 'right',
    keywords: ['肝', '胃', '胆', '肠', '吐', '呕', '便', '消化', '食欲', '便秘', '腹泻', '腹痛', '胰腺炎', '克罗恩', '胃管', '大便', '黄染'],
  },
  {
    id: 'pancreas',
    name: '胰腺与血糖',
    icon: '🩸',
    pctX: 50, pctY: 38, // 胃下方胰腺
    side: 'right',
    keywords: ['血糖', '胰', '糖尿病', '尿糖', '糖化', '空腹血糖', '餐后血糖', 'HbA1c', '控糖', '胰岛素'],
  },
  {
    id: 'kidneys',
    name: '肾脏与泌尿',
    icon: '🚽',
    pctX: 47, pctY: 44, // 肾脏与膀胱
    side: 'right',
    keywords: ['肾', '尿', '输尿管', '膀胱', '留置导尿', '尿管', '肌酐', '尿酸'],
  },
  {
    id: 'spine',
    name: '脊柱与骨骼',
    icon: '🦴',
    pctX: 50, pctY: 35, // 脊柱中轴
    side: 'left',
    keywords: ['骨', '脊柱', '椎', '骨折', '腰', '骨质', '股骨', '关节', '髋部', 'L2', '颈椎', '腰椎', '压缩', '摔伤', '硬板床'],
  },
  {
    id: 'limbs',
    name: '四肢与运动',
    icon: '🦵',
    pctX: 42, pctY: 74, // 下肢与膝关节
    side: 'left',
    keywords: ['四肢', '下肢', '上肢', '翻身', '卧床', '活动障碍', '肢体', '膝', '足', '行走', '步态', '肌力', '步数', '摔伤'],
  },
];

const SYSTEMIC_DEFS = [
  {
    id: 'infectious',
    name: '传染与免疫',
    icon: '🦠',
    pctX: 72, pctY: 24, // 身体右侧
    side: 'right',
    keywords: ['乙肝', '丙肝', '梅毒', '结核', '流感', '新冠', '隔离', '阳性', '感染', '传染', '带状疱疹', '破伤风', '乌司奴单抗'],
  },
  {
    id: 'allergy',
    name: '皮肤与屏障',
    icon: '🛡️',
    pctX: 28, pctY: 24, // 身体左侧
    side: 'left',
    keywords: ['过敏', '青霉素', '皮疹', '荨麻疹', '压疮', '褥疮', '皮肤', '受压', 'Braden', '气垫床'],
  },
];

// 色阶配置
const SEVERITY = {
  high:   { label: '重度关注', class: 'sev-high',   color: '#f43f5e' },
  medium: { label: '中度异常', class: 'sev-medium', color: '#f59e0b' },
  low:    { label: '轻度关注', class: 'sev-low',    color: '#0d9488' },
};

function getSeverity(score) {
  if (score >= 0.75) return SEVERITY.high;
  if (score >= 0.45) return SEVERITY.medium;
  return SEVERITY.low;
}

// ─── 动态自然语言扫描器 ──────────────────────────────────────────────────────
function extractDynamicObservations(markdownContent) {
  if (!markdownContent) return [];

  const lines = markdownContent.split('\n');
  const allDefs = [...ORGAN_DEFS, ...SYSTEMIC_DEFS];

  const organMatches = {};
  allDefs.forEach(def => {
    organMatches[def.id] = {
      def,
      lines: new Set(),
      maxScore: 0.3
    };
  });

  lines.forEach(rawLine => {
    const cleanLine = rawLine.trim();
    if (!cleanLine) return;
    if (cleanLine.startsWith('#')) return;
    if (cleanLine.includes('快捷导航') || cleanLine.includes('.md)')) return;
    if (cleanLine.startsWith('* [') && cleanLine.includes('](')) return;

    const sentences = cleanLine.split(/[。！；？，,;!?\n]/);

    sentences.forEach(sentence => {
      let cleanSentence = sentence.trim();
      cleanSentence = cleanSentence.replace(/^[\s-*•+]*\d*\.?\s*/, '');
      cleanSentence = cleanSentence
        .replace(/\*\*/g, '')
        .replace(/\[!(IMPORTANT|WARNING|TIP|NOTE|CAUTION)\]/g, '')
        .replace(/>\s*/g, '')
        .replace(/\[🔗\s*溯源\]\((.*?)\)/g, '')
        .replace(/content:\s*"/g, '')
        .replace(/"$/g, '')
        .trim();

      if (cleanSentence.length < 3) return;

      allDefs.forEach(def => {
        const hasKeyword = def.keywords.some(kw => {
          if (kw === '尿') {
            return cleanSentence.includes('尿') && !cleanSentence.includes('糖尿病') && !cleanSentence.includes('尿糖');
          }
          return cleanSentence.toLowerCase().includes(kw.toLowerCase());
        });

        if (hasKeyword) {
          let displayText = cleanSentence;
          if (displayText.length > 32) {
            displayText = displayText.substring(0, 30) + '...';
          }
          organMatches[def.id].lines.add(displayText);

          let lineScore = 0.35;
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
            textLower.includes('呼吸急促') ||
            textLower.includes('脑出血') ||
            textLower.includes('脑疝') ||
            textLower.includes('破伤风')
          ) {
            lineScore = 0.85;
          } else if (
            textLower.includes('警告') ||
            textLower.includes('异常') ||
            textLower.includes('低血氧') ||
            textLower.includes('糖尿病') ||
            textLower.includes('失调') ||
            textLower.includes('波动') ||
            textLower.includes('控制') ||
            textLower.includes('哮喘') ||
            textLower.includes('黄染') ||
            textLower.includes('摔伤')
          ) {
            lineScore = 0.6;
          }

          if (lineScore > organMatches[def.id].maxScore) {
            organMatches[def.id].maxScore = lineScore;
          }
        }
      });
    });
  });

  const activeOrgans = [];
  allDefs.forEach(def => {
    const match = organMatches[def.id];
    if (match.lines.size > 0) {
      const list = Array.from(match.lines).slice(0, 2).map(txt => ({
        content: txt,
        score: match.maxScore
      }));

      activeOrgans.push({
        ...def,
        score: match.maxScore,
        observations: list,
        topObservation: list[0]?.content || ''
      });
    }
  });

  // 按受损分值降序排列，使最严重的器官排在最前
  return activeOrgans.sort((a, b) => b.score - a.score);
}

export default function AnatomicalHealthMap({ markdownContent, selectedOrgan, onSelectOrgan }) {
  const bodyWrapperRef = useRef(null);
  const [internalSelected, setInternalSelected] = useState(null);
  const [svgContent, setSvgContent] = useState('');
  const [hoveredId, setHoveredId] = useState(null);

  // 异步加载 Wikipedia 的真实高精 organs.svg 文件并动态裁剪 viewBox 125 140 210 945
  useEffect(() => {
    let isMounted = true;
    fetch('/organs.svg')
      .then(res => res.text())
      .then(text => {
        if (!isMounted) return;
        let cleanSvg = text.replace(/<\?xml[^>]*\?>/i, '').replace(/<!DOCTYPE[^>]*>/i, '');
        cleanSvg = cleanSvg.replace(/<svg([^>]*)(?:viewBox="[^"]*")?([^>]*)>/i, (match, before, after) => {
          const cleanBefore = before.replace(/\b(width|height)="[^"]*"/gi, '');
          const cleanAfter = after.replace(/\b(width|height)="[^"]*"/gi, '');
          return `<svg ${cleanBefore} viewBox="125 140 210 945" style="width: 100%; height: 100%; display: block; object-fit: contain;" ${cleanAfter}>`;
        });
        setSvgContent(cleanSvg);
      })
      .catch(err => {
        console.error('Failed to load organs.svg:', err);
      });

    return () => { isMounted = false; };
  }, []);

  // 动态分析当前病历观察
  const activeOrgans = useMemo(() => {
    return extractDynamicObservations(markdownContent);
  }, [markdownContent]);

  const activeId = selectedOrgan || internalSelected || (activeOrgans[0]?.id ?? null);

  const handleSelect = (id) => {
    setInternalSelected(id);
    if (onSelectOrgan) {
      onSelectOrgan(id);
    }
  };

  return (
    <section className="anatomy-stage-card">
      <div className="stage-header">
        <div className="stage-title">
          <span className="material-symbols-outlined" style={{ color: 'var(--teal-primary)' }}>accessibility_new</span>
          数字化人体解剖透视图 (肉身受损锚点)
        </div>
        <span className="stage-badge">
          {activeOrgans.length > 0 ? `已检出 ${activeOrgans.length} 处生理受损点` : '基于当前病历动态扫描'}
        </span>
      </div>

      {/* 真实人体解剖透视舞台 */}
      <div className="anatomy-body-wrapper" ref={bodyWrapperRef}>
        {/* 背景微光 */}
        <div className="anatomy-ambient-glow" />

        {/* 动态载入的 Wikipedia 真实医学解剖矢量图 */}
        {svgContent ? (
          <div
            className="anatomy-svg-inner"
            dangerouslySetInnerHTML={{ __html: svgContent }}
          />
        ) : (
          <div className="anatomy-loading-spinner">
            <span className="material-symbols-outlined" style={{ animation: 'spin 1.5s linear infinite', color: '#0d9488' }}>progress_activity</span>
            <span style={{ fontSize: '12px', color: '#64748b' }}>载入人体器官图...</span>
          </div>
        )}

        {/* 覆盖在真实器官上的动态脉冲标点 Pins */}
        {activeOrgans.map(organ => {
          const sev = getSeverity(organ.score);
          const isSelected = activeId === organ.id;
          const isHovered = hoveredId === organ.id;

          return (
            <div
              key={organ.id}
              className={`anatomy-pin ${isSelected ? 'active' : ''} ${isHovered ? 'hovered' : ''}`}
              style={{
                top: `${organ.pctY}%`,
                left: `${organ.pctX}%`,
                '--pin-color': sev.color
              }}
              onClick={() => handleSelect(organ.id)}
              onMouseEnter={() => setHoveredId(organ.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <div className="pin-dot">
                <div className="pin-pulse" />
              </div>
              <div className="pin-chip">
                <span>{organ.icon}</span>
                <span>{organ.name.split('与')[0]}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 底部动态检出的受损器官胶囊列表（完全跟随当前患者真实数据联动，绝不硬编码） */}
      <div className="stage-organ-strip">
        {activeOrgans.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: '12px', padding: '10px 14px', textAlign: 'center', width: '100%', background: '#f8fafc', borderRadius: '12px' }}>
            ℹ️ 当前患者 Wiki 内容中暂未检出显著脏器受损警报。
          </div>
        ) : (
          activeOrgans.slice(0, 4).map(organ => {
            const sev = getSeverity(organ.score);
            const isSelected = activeId === organ.id;

            return (
              <div
                key={organ.id}
                className={`organ-mini-pill ${isSelected ? 'active' : ''}`}
                onClick={() => handleSelect(organ.id)}
              >
                <div className="mini-pill-name">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>{organ.icon}</span>
                    <span style={{ fontWeight: '700' }}>{organ.name}</span>
                  </div>
                  <span className="mini-pill-sev-tag" style={{ color: sev.color, background: `${sev.color}15` }}>
                    {sev.label}
                  </span>
                </div>
                <div className="mini-pill-status" title={organ.topObservation}>
                  {organ.topObservation || '常规监测'}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
