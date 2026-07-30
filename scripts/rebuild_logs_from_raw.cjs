/**
 * rebuild_logs_from_raw.cjs
 * 用完整原始材料（零删减）重建4个案例的日志，然后触发AI同步
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const RAW_DIR = path.join(__dirname, '../docs/raw_cases_material');

// ── 案例一：老年慢阻肺 + 脊柱骨折 + 糖尿病 ──────────────────────────────
// 原始材料来源：case_001_raw.md（3个材料全部无删减）
const case1_raw = fs.readFileSync(path.join(RAW_DIR, 'case_001_raw.md'), 'utf8');

// 按材料分割
function extractSection(text, heading) {
  const regex = new RegExp(`## 📄 ${heading}[\\s\\S]*?(?=## 📄 |$)`);
  const m = text.match(regex);
  return m ? m[0].trim() : '';
}

const logs_elderly = [
  {
    id: 'log_c1_1',
    type: 'phone',
    title: '3月17日 ASR 慢阻肺咨询电话录音',
    timestamp: '2026-03-17T14:43:10.000Z',
    synced: false,
    content: extractSection(case1_raw, '材料一：ASR 电话问诊录音转录原文')
  },
  {
    id: 'log_c1_2',
    type: 'ocr',
    title: '5月5日 急诊入院病历记录 OCR',
    timestamp: '2026-05-05T10:20:00.000Z',
    synced: false,
    content: extractSection(case1_raw, '材料二：急诊入院病历记录 OCR')
  },
  {
    id: 'log_c1_3',
    type: 'ocr',
    title: '5月7日 骨科脊柱病区手腕带与监护 OCR',
    timestamp: '2026-05-07T09:00:00.000Z',
    synced: false,
    content: extractSection(case1_raw, '材料三：脊柱病区手腕带及床头监护信息 OCR')
  }
];

// ── 案例二：克罗恩病青年 + 穿戴监测 ─────────────────────────────────────
const case3_raw = fs.readFileSync(path.join(RAW_DIR, 'case_003_raw.md'), 'utf8');

const logs_crohn = [
  {
    id: 'log_c2_1',
    type: 'ocr',
    title: '7月31日 消化内科住院通知单 OCR',
    timestamp: '2025-07-31T09:30:00.000Z',
    synced: false,
    content: extractSection(case3_raw, '材料一：消化内科常规住院通知单 OCR')
  },
  {
    id: 'log_c2_2',
    type: 'wechat',
    title: '11月24日 31天穿戴生理指标异常报告',
    timestamp: '2025-11-24T00:00:00.000Z',
    synced: false,
    content: extractSection(case3_raw, '材料二：31天可穿戴智能设备生理指标连续报告')
  },
  {
    id: 'log_c2_3',
    type: 'ocr',
    title: '8月2日 消化科床头卡 OCR',
    timestamp: '2025-08-02T08:15:00.000Z',
    synced: false,
    content: extractSection(case3_raw, '材料三：消化科床头卡 OCR')
  }
];

// ── 案例三：脑出血ICU ─────────────────────────────────────────────────────
const case5_raw = fs.readFileSync(path.join(RAW_DIR, 'case_005_raw.md'), 'utf8');

const logs_stroke = [
  {
    id: 'log_c3_1',
    type: 'phone',
    title: '9月28日 120 ASR 紧急呼救电话录音转录',
    timestamp: '2025-09-28T14:15:00.000Z',
    synced: false,
    content: extractSection(case5_raw, '材料一：120 ASR 电话紧急呼救录音转录原文')
  },
  {
    id: 'log_c3_2',
    type: 'ocr',
    title: '9月28日 急诊抢救病历单 OCR',
    timestamp: '2025-09-28T14:30:00.000Z',
    synced: false,
    content: extractSection(case5_raw, '材料二：急诊抢救病历单 OCR')
  },
  {
    id: 'log_c3_3',
    type: 'ocr',
    title: '9月28日 ICU 重症监护特级日志 OCR',
    timestamp: '2025-09-28T18:00:00.000Z',
    synced: false,
    content: extractSection(case5_raw, '材料三：ICU 重症监护特级日志 OCR')
  }
];

// ── 案例四：儿童骑车摔伤 + 退热后手脚黄染 ────────────────────────────────
const case2_raw = fs.readFileSync(path.join(RAW_DIR, 'case_002_raw.md'), 'utf8');
const case6_raw = fs.readFileSync(path.join(RAW_DIR, 'case_006_raw.md'), 'utf8');

const logs_pediatric = [
  {
    id: 'log_c4_1',
    type: 'phone',
    title: '5月25日 ASR 骑车摔伤电话问诊录音',
    timestamp: '2026-05-25T15:12:14.000Z',
    synced: false,
    // 案例二全文（无分节标题，整个文件即一条记录）
    content: case2_raw.split('---').slice(1).join('---').trim()
  },
  {
    id: 'log_c4_2',
    type: 'phone',
    title: '3月17日 ASR 退热后手脚黄染电话问诊录音',
    timestamp: '2026-03-17T10:15:30.000Z',
    synced: false,
    content: case6_raw.split('---').slice(1).join('---').trim()
  }
];

// ── 写入日志文件 ──────────────────────────────────────────────────────────
const updates = [
  { id: 'case_combined_elderly',            logs: logs_elderly },
  { id: 'case_combined_crohn_wearable',     logs: logs_crohn },
  { id: 'case_combined_stroke_multichannel',logs: logs_stroke },
  { id: 'case_combined_pediatric',          logs: logs_pediatric },
];

updates.forEach(({ id, logs }) => {
  const file = path.join(LOGS_DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(logs, null, 2), 'utf8');

  // 验证内容长度
  const total = logs.reduce((sum, l) => sum + l.content.length, 0);
  console.log(`✅ ${id}: ${logs.length} 条日志，总字符 ${total}`);

  // 抽样打印第一条内容前100字
  console.log(`   第1条预览: ${logs[0].content.slice(0, 80).replace(/\n/g,' ')}...`);
});

// 更新 lastSyncAt 为 null（标记需要重新同步）
const clients = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
clients.forEach(c => {
  if (updates.find(u => u.id === c.id)) {
    c.lastSyncAt = null;
  }
});
fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));

console.log('\n✅ 所有日志已用完整原始材料重建完成。接下来运行 AI 同步。');
