import React, { useState, useMemo } from 'react';
import './AnatomicalHealthMap.css';

// 器官核心定义与关键词扫描映射
const ORGAN_DEFINITIONS = [
  {
    id: 'lung',
    name: '呼吸系统',
    icon: '🫁',
    pctX: 28, pctY: 26,
    color: '#f59e0b',
    keywords: ['肺', '呼吸', '血氧', 'spo2', 'SpO2', '咳嗽', '咳痰', '喘', '吸氧', '雾化', '哮喘', '慢阻肺', '气促'],
    defaultDesc: '慢阻肺20年 · SpO2 89% 气促',
    statusDesc: '慢阻肺20年 · SpO2 89% 气促'
  },
  {
    id: 'spine',
    name: '骨骼系统',
    icon: '🦴',
    pctX: 74, pctY: 48,
    color: '#f43f5e',
    keywords: ['骨', '脊柱', '椎', '骨折', '腰', '骨质', '股骨', '关节', '髋部', 'L2', '腰椎', '压缩', '摔伤'],
    defaultDesc: 'L2压缩骨折 · 绝对硬板床制动',
    statusDesc: 'L2压缩骨折 · 绝对硬板床制动'
  },
  {
    id: 'endocrine',
    name: '代谢内分泌',
    icon: '🩸',
    pctX: 22, pctY: 38,
    color: '#10b981',
    keywords: ['血糖', '胰', '糖尿病', '尿糖', '糖化', '二甲双胍', '空腹血糖', '餐后血糖', 'HbA1c', '控糖'],
    defaultDesc: '4年糖尿病 · 禁食水胰岛素',
    statusDesc: '4年糖尿病 · 禁食水胰岛素'
  },
  {
    id: 'skin',
    name: '皮肤屏障',
    icon: '🛡️',
    pctX: 72, pctY: 58,
    color: '#6366f1',
    keywords: ['压疮', '褥疮', '皮肤', '翻身', '卧床', 'Braden', '气垫床', '受压'],
    defaultDesc: 'Braden 11分 · 双人轴线翻身',
    statusDesc: 'Braden 11分 · 双人轴线翻身'
  },
  {
    id: 'brain',
    name: '脑与神经',
    icon: '🧠',
    pctX: 50, pctY: 8,
    color: '#8b5cf6',
    keywords: ['脑', '意识', '神志', '认知', '昏迷', '嗜睡', '失语', '偏瘫', '肌力', '瞳孔', '头晕', '头痛', '脑出血'],
    defaultDesc: '神志清楚 · 双下肢肌力正常',
    statusDesc: '神志清楚 · 双下肢肌力正常'
  }
];

export default function AnatomicalHealthMap({ markdownContent, selectedOrgan, onSelectOrgan }) {
  const [internalSelected, setInternalSelected] = useState(selectedOrgan || 'lung');

  // 根据当前 Markdown 动态扫描匹配受损器官
  const detectedOrgans = useMemo(() => {
    if (!markdownContent) {
      return ORGAN_DEFINITIONS.slice(0, 4).map(d => ({
        ...d,
        active: true,
        matchCount: 0,
        statusDesc: d.defaultDesc || '常规监测'
      }));
    }
    const contentLower = markdownContent.toLowerCase();

    return ORGAN_DEFINITIONS.map(def => {
      const matchCount = def.keywords.filter(k => contentLower.includes(k.toLowerCase())).length;
      let statusDesc = def.defaultDesc;

      // 提取匹配的简短事实片段
      const lines = markdownContent.split('\n');
      for (const line of lines) {
        const found = def.keywords.some(k => line.includes(k));
        if (found && line.length > 8 && !line.startsWith('#')) {
          const clean = line.replace(/[#*`>-]/g, '').trim();
          if (clean.length > 6) {
            statusDesc = clean.length > 24 ? clean.slice(0, 24) + '...' : clean;
            break;
          }
        }
      }

      return {
        ...def,
        active: matchCount > 0,
        matchCount,
        statusDesc: statusDesc || def.defaultDesc || '指标正常'
      };
    }).filter(d => d.active || ['lung', 'spine', 'endocrine', 'skin'].includes(d.id));
  }, [markdownContent]);

  const activeId = selectedOrgan || internalSelected;

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
        <span className="stage-badge">点击体标联动右侧病历</span>
      </div>

      {/* 仿生透视舞台 */}
      <div className="anatomy-body-wrapper">
        <svg className="anatomy-svg-canvas" viewBox="0 0 200 390">
          {/* 头部 */}
          <ellipse cx="100" cy="35" rx="20" ry="24" fill="#e2e8f0" stroke="#cbd5e1" strokeWidth="2" />
          {/* 颈部 */}
          <rect x="94" y="58" width="12" height="16" fill="#e2e8f0" />
          {/* 躯干外轮廓 */}
          <path
            d="M60,74 C75,70 125,70 140,74 C148,90 144,140 138,180 C130,200 135,210 132,230 L68,230 C65,210 70,200 62,180 C56,140 52,90 60,74 Z"
            fill="#e8edf3"
            stroke="#cbd5e1"
            strokeWidth="2"
          />
          {/* 上肢手臂 */}
          <path d="M60,75 L38,150 L46,152 L64,85 Z" fill="#e2e8f0" opacity="0.8" />
          <path d="M140,75 L162,150 L154,152 L136,85 Z" fill="#e2e8f0" opacity="0.8" />
          {/* 下肢大腿 */}
          <path d="M72,230 L74,350 L88,350 L96,230 Z" fill="#e2e8f0" opacity="0.8" />
          <path d="M128,230 L126,350 L112,350 L104,230 Z" fill="#e2e8f0" opacity="0.8" />

          {/* 解剖器官高亮图层 */}
          {/* 1. 肺叶 */}
          <g
            id="svg-lung"
            style={{ cursor: 'pointer' }}
            onClick={() => handleSelect('lung')}
            className={activeId === 'lung' ? 'organ-svg-active' : ''}
          >
            <path d="M74,90 C70,110 72,130 84,136 C92,136 94,115 92,95 C88,88 78,85 74,90 Z" fill="#fef3c7" stroke="#f59e0b" strokeWidth={activeId === 'lung' ? 3 : 2} opacity="0.95" />
            <path d="M126,90 C130,110 128,130 116,136 C108,136 106,115 108,95 C112,88 122,85 126,90 Z" fill="#fef3c7" stroke="#f59e0b" strokeWidth={activeId === 'lung' ? 3 : 2} opacity="0.95" />
          </g>

          {/* 2. 脊柱中轴与 L2 椎体骨折截面 */}
          <g
            id="svg-spine"
            style={{ cursor: 'pointer' }}
            onClick={() => handleSelect('spine')}
            className={activeId === 'spine' ? 'organ-svg-active' : ''}
          >
            <line x1="100" y1="80" x2="100" y2="190" stroke="#94a3b8" strokeWidth="3" strokeDasharray="3,2" />
            <rect x="91" y="152" width="18" height="11" rx="3" fill="#fee2e2" stroke="#f43f5e" strokeWidth={activeId === 'spine' ? 3.5 : 2.5} />
          </g>

          {/* 3. 胰腺内分泌 */}
          <g
            id="svg-endocrine"
            style={{ cursor: 'pointer' }}
            onClick={() => handleSelect('endocrine')}
            className={activeId === 'endocrine' ? 'organ-svg-active' : ''}
          >
            <path d="M88,140 C100,136 112,138 116,144 C110,148 95,148 88,140 Z" fill="#dcfce7" stroke="#10b981" strokeWidth={activeId === 'endocrine' ? 3 : 2} />
          </g>

          {/* 4. 骶尾部皮肤受压点 */}
          <g
            id="svg-skin"
            style={{ cursor: 'pointer' }}
            onClick={() => handleSelect('skin')}
            className={activeId === 'skin' ? 'organ-svg-active' : ''}
          >
            <circle cx="100" cy="205" r="7" fill="#e0e7ff" stroke="#6366f1" strokeWidth={activeId === 'skin' ? 3 : 2} />
          </g>
        </svg>

        {/* 动态脉冲体标 Pins */}
        {detectedOrgans.map(organ => (
          <div
            key={organ.id}
            className={`anatomy-pin ${activeId === organ.id ? 'active' : ''}`}
            style={{
              top: `${organ.pctY}%`,
              left: `${organ.pctX}%`,
              '--pin-color': organ.color
            }}
            onClick={() => handleSelect(organ.id)}
          >
            <div className="pin-dot">
              <div className="pin-pulse" />
            </div>
            <div className="pin-chip">
              <span>{organ.icon}</span>
              <span>{organ.name}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 底部 4 大系统过滤指示条 */}
      <div className="stage-organ-strip">
        {detectedOrgans.slice(0, 4).map(organ => (
          <div
            key={organ.id}
            className={`organ-mini-pill ${activeId === organ.id ? 'active' : ''}`}
            onClick={() => handleSelect(organ.id)}
          >
            <div className="mini-pill-name">{organ.icon} {organ.name}</div>
            <div className="mini-pill-status" style={{ color: organ.color }}>
              {(organ.statusDesc || organ.defaultDesc || '常规指标').slice(0, 14)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
