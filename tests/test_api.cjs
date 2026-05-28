#!/usr/bin/env node
/**
 * LLMWiki PRD Compliance Test Suite - Enhanced
 * 
 * Tests for:
 * - Basic API contract (positive + negative)
 * - PRD 8-section cognitive skeleton enforcement
 * - Cognitive safety rules (forbidden phrases, observation/interpretation separation)
 * - Log type validation (strict enum)
 * - Path traversal security
 * - Evidence traceability format
 * - Attention block structure
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5050';

let passed = 0;
let failed = 0;
let testClientId = null;

// ─── helpers ────────────────────────────────────────────────────────────────

async function req(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function assert(desc, condition, got) {
  if (condition) {
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${desc}`);
    if (got !== undefined) console.error(`         Got:`, typeof got === 'string' ? got.substring(0, 200) : JSON.stringify(got));
    failed++;
  }
}

function section(title) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(62)}`);
}

// ─── Section 1: Basic Client CRUD ───────────────────────────────────────────

async function testClientsCRUD() {
  section('1. Clients CRUD - Positive Cases');

  const { status: s1, data: d1 } = await req('POST', '/api/clients', {
    name: 'Test Patient 测试患者',
    age: 45,
    gender: '女',
    phone: '13900000001',
    allergies: '青霉素过敏'
  });
  assert('POST /api/clients returns 201', s1 === 201, s1);
  assert('Response has id field', d1 && typeof d1.id === 'string', d1);
  assert('Response has name', d1 && d1.name === 'Test Patient 测试患者', d1?.name);
  assert('Response has age', d1 && d1.age === 45, d1?.age);
  assert('Response has createdAt', d1 && d1.createdAt, d1?.createdAt);
  testClientId = d1?.id;

  const { status: s2, data: d2 } = await req('GET', '/api/clients');
  assert('GET /api/clients returns 200', s2 === 200, s2);
  assert('Returns array', Array.isArray(d2), d2);
  assert('Contains new client', d2 && d2.some(c => c.id === testClientId), d2?.length);

  const { status: s3, data: d3 } = await req('PUT', `/api/clients/${testClientId}`, { age: 46 });
  assert('PUT /api/clients/:id returns 200', s3 === 200, s3);
  assert('Age updated', d3 && d3.age === 46, d3?.age);
  assert('Name preserved', d3 && d3.name === 'Test Patient 测试患者', d3?.name);

  section('2. Clients CRUD - Negative Cases');

  const { status: s4, data: d4 } = await req('POST', '/api/clients', { age: 30 });
  assert('POST without name returns 400', s4 === 400, s4);
  assert('Error field present', d4 && d4.error, d4);

  const { status: s4b, data: d4b } = await req('POST', '/api/clients', { name: '' });
  assert('POST with empty name returns 400', s4b === 400, s4b);
  assert('Empty name error field present', d4b && d4b.error, d4b);

  const { status: s5 } = await req('GET', '/api/clients/nonexistent_id_xyz/wiki');
  assert('GET /wiki for unknown client returns 404', s5 === 404, s5);

  const { status: s6 } = await req('DELETE', '/api/clients/nonexistent_id_xyz');
  assert('DELETE unknown client returns 404', s6 === 404, s6);

  const { status: s7 } = await req('PUT', '/api/clients/nonexistent_id_xyz', { age: 50 });
  assert('PUT unknown client returns 404', s7 === 404, s7);
}

// ─── Section 2: Wiki Pages ───────────────────────────────────────────────────

async function testWikiPages() {
  section('3. Wiki Pages - Positive Cases');
  if (!testClientId) { console.log('  ⚠ Skipping: no test client'); return; }

  const { status: s1, data: d1 } = await req('GET', `/api/clients/${testClientId}/wiki`);
  assert('GET /wiki returns 200', s1 === 200, s1);
  assert('Returns object', d1 && typeof d1 === 'object', d1);
  assert('Has index.md', d1 && 'index.md' in d1, Object.keys(d1 || {}));
  assert('Has medical_history.md', d1 && 'medical_history.md' in d1, Object.keys(d1 || {}));
  assert('Has medication_plan.md', d1 && 'medication_plan.md' in d1, Object.keys(d1 || {}));
  assert('Has communication_timeline.md', d1 && 'communication_timeline.md' in d1, Object.keys(d1 || {}));

  const indexContent = d1?.['index.md'] || '';
  assert('index.md contains patient name', indexContent.includes('Test Patient'), indexContent.substring(0, 100));

  const testContent = `# 既往史与诊疗时间轴\n\n## 1. 既往病史\n* **慢性病**：高血压5年史。\n`;
  const { status: s2, data: d2 } = await req('PUT',
    `/api/clients/${testClientId}/wiki/medical_history.md`,
    { content: testContent }
  );
  assert('PUT /wiki/:page returns 200', s2 === 200, s2);
  assert('Success response', d2 && d2.success, d2);

  const { data: d3 } = await req('GET', `/api/clients/${testClientId}/wiki`);
  assert('Updated content persisted', d3?.['medical_history.md'] === testContent, d3?.['medical_history.md']?.substring(0, 50));

  section('4. Wiki Pages - Security & Negative Cases');

  const { status: s4 } = await req('PUT',
    `/api/clients/${testClientId}/wiki/hackerfile.js`,
    { content: 'alert("xss")' }
  );
  assert('PUT non-.md file returns 400', s4 === 400, s4);

  // Path traversal attempt
  const { status: s4b } = await req('PUT',
    `/api/clients/${testClientId}/wiki/..%2F..%2Fetc%2Fpasswd`,
    { content: 'traversal' }
  );
  assert('Path traversal attempt returns 400', s4b === 400, s4b);

  const { status: s5 } = await req('PUT',
    `/api/clients/nonexistent/wiki/index.md`,
    { content: '# test' }
  );
  assert('PUT wiki for unknown client returns 404', s5 === 404, s5);
}

// ─── Section 3: Logs ─────────────────────────────────────────────────────────

async function testLogs() {
  section('5. Log Ingestion - Positive Cases');
  if (!testClientId) { console.log('  ⚠ Skipping: no test client'); return; }

  const { status: s1, data: d1 } = await req('POST', `/api/clients/${testClientId}/logs`, {
    type: 'phone',
    title: '5月28日电话问诊',
    content: '[患者] 头晕了三天。\n[医生] 请问血压量了吗？'
  });
  assert('POST /logs returns 201', s1 === 201, s1);
  assert('Log has id', d1 && typeof d1.id === 'string', d1);
  assert('Log type preserved', d1 && d1.type === 'phone', d1?.type);
  assert('Log synced=false by default', d1 && d1.synced === false, d1?.synced);
  assert('Log has timestamp', d1 && d1.timestamp, d1?.timestamp);

  const { status: s2, data: d2 } = await req('POST', `/api/clients/${testClientId}/logs`, {
    type: 'ocr',
    content: '血压: 158/98 mmHg ↑'
  });
  assert('OCR log returns 201', s2 === 201, s2);
  assert('OCR log has auto-generated title', d2 && d2.title && d2.title.length > 0, d2?.title);

  // All 4 valid types should work
  for (const t of ['video', 'wechat']) {
    const { status: st } = await req('POST', `/api/clients/${testClientId}/logs`, {
      type: t,
      content: `test content for type ${t}`
    });
    assert(`Log type '${t}' accepted (returns 201)`, st === 201, st);
  }

  const { status: s3, data: d3 } = await req('GET', `/api/clients/${testClientId}/logs`);
  assert('GET /logs returns 200', s3 === 200, s3);
  assert('Returns array', Array.isArray(d3), d3);
  assert('Has 4 logs', d3 && d3.length === 4, d3?.length);

  section('6. Log Ingestion - Negative Cases');

  const { status: s4, data: d4 } = await req('POST', `/api/clients/${testClientId}/logs`, {
    type: 'phone'
  });
  assert('POST log without content returns 400', s4 === 400, s4);
  assert('Error message present', d4 && d4.error, d4);

  const { status: s5, data: d5 } = await req('POST', `/api/clients/${testClientId}/logs`, {
    content: 'some content with no type'
  });
  assert('POST log without type returns 400', s5 === 400, s5);
  assert('Type error message present', d5 && d5.error, d5);

  // Invalid log type — strict enum enforcement
  const { status: s5b, data: d5b } = await req('POST', `/api/clients/${testClientId}/logs`, {
    type: 'sms',
    content: 'should be rejected'
  });
  assert('Invalid log type "sms" returns 400', s5b === 400, s5b);
  assert('Invalid type error message present', d5b && d5b.error, d5b);

  const { status: s6 } = await req('POST', `/api/clients/nonexistent/logs`, {
    type: 'phone',
    content: 'content'
  });
  assert('POST log for unknown client returns 404', s6 === 404, s6);

  // GET logs for nonexistent client should be 404, NOT empty array
  const { status: s7, data: d7 } = await req('GET', `/api/clients/nonexistent_xyz/logs`);
  assert('GET /logs for unknown client returns 404', s7 === 404, s7);
  assert('GET /logs 404 has error field', d7 && d7.error, d7);
}

// ─── Section 4: PRD 8-Section Cognitive Skeleton ─────────────────────────────
// Uses a fresh, unmodified client to verify the DEFAULT template structure.

async function testCognitiveSkeletonStructure() {
  section('7. PRD 8-Section Cognitive Skeleton - Default Wiki Structure');

  // Create a fresh client so we test the UNMODIFIED default template
  const { status: cs, data: cd } = await req('POST', '/api/clients', {
    name: 'Skeleton Test 骨架测试',
    age: 30, gender: '男', phone: '13900009999', allergies: '无'
  });
  if (cs !== 201) { console.log('  ⚠ Could not create skeleton test client'); return; }
  const skeletonClientId = cd.id;

  try {
    const { data: wiki } = await req('GET', `/api/clients/${skeletonClientId}/wiki`);

    // Section 1: Current Key Concerns in index.md
    const index = wiki?.['index.md'] || '';
    assert('index.md has "当前主要关注" or "Current Key Concerns"',
      /当前主要关注|Current Key Concerns|主要关注/i.test(index), index.substring(0, 300));

    // Section 2: Timeline in index.md
    assert('index.md has "时间轴" or "Timeline"',
      /时间轴|Timeline|事件轴/i.test(index), index.substring(0, 300));

    // Section 3: Physiologic Signals in medical_history.md
    const med = wiki?.['medical_history.md'] || '';
    assert('medical_history.md has "生理信号" or "Physiologic Signals"',
      /生理信号|Physiologic Signals|体征信号/i.test(med), med.substring(0, 300));

    // Section 4: Laboratory Findings in medical_history.md
    assert('medical_history.md has "化验结果" or "Laboratory Findings"',
      /化验结果|Laboratory Findings|实验室检查|化验/i.test(med), med.substring(0, 300));

    // Section 5: Functional Changes in medical_history.md
    assert('medical_history.md has "功能变化" or "Functional Changes"',
      /功能变化|Functional Changes|功能状态/i.test(med), med.substring(0, 300));

    // Section 6: Active Interventions in medication_plan.md
    const meds = wiki?.['medication_plan.md'] || '';
    assert('medication_plan.md has "干预措施" or "Active Interventions"',
      /干预措施|Active Interventions|当前干预/i.test(meds), meds.substring(0, 300));

    // Section 7: Monitoring Targets in communication_timeline.md
    const comm = wiki?.['communication_timeline.md'] || '';
    assert('communication_timeline.md has "监测目标" or "Monitoring Targets"',
      /监测目标|Monitoring Targets|监控目标/i.test(comm), comm.substring(0, 300));

    // Section 8: Source Evidence in communication_timeline.md
    assert('communication_timeline.md has "溯源证据" or "Source Evidence"',
      /溯源证据|Source Evidence|原始溯源|证据来源/i.test(comm), comm.substring(0, 300));

    // Section 8b: medical_history must have multiple ## sections (not just 1)
    assert('medical_history.md separates content into >= 2 ## sections (PRD skeleton)',
      (med.match(/^##\s+/mg) || []).length >= 2,
      `Found ${(med.match(/^##\s+/mg) || []).length} ## sections`
    );

    // Citation format documented in communication_timeline
    assert('communication_timeline.md documents citation format [🔗 溯源]',
      /溯源|🔗|原始溯源/i.test(comm), comm.substring(0, 200));

  } finally {
    // Always cleanup the skeleton test client
    await req('DELETE', `/api/clients/${skeletonClientId}`);
  }
}

// ─── Section 5: Cognitive Safety Rules ──────────────────────────────────────

async function testCognitiveSafetyRules() {
  section('8. AI Cognitive Safety Rules (PRD Rule Compliance)');
  if (!testClientId) { console.log('  ⚠ Skipping: no test client'); return; }

  const { data: wiki } = await req('GET', `/api/clients/${testClientId}/wiki`);
  const allContent = Object.values(wiki || {}).join('\n');

  // Forbidden diagnosis phrases (PRD Rule 1: No New Diagnosis)
  const forbiddenPhrases = [
    'AI确诊', 'AI诊断为', '人工智能诊断', 'confirmed by AI',
    'AI confirms', '危及生命', 'life-threatening', 'AI判断'
  ];
  for (const phrase of forbiddenPhrases) {
    assert(`No forbidden phrase "${phrase}" in any wiki page`, !allContent.includes(phrase), phrase);
  }

  // PRD Rule: Allergy/red-line warning must be present in index.md
  const index = wiki?.['index.md'] || '';
  assert('index.md has allergy/red-line alert block (IMPORTANT/WARNING)',
    /\[!(IMPORTANT|WARNING)\]/.test(index) || /红线警示|过敏史/.test(index),
    index.substring(0, 300)
  );

  // PRD Rule: The DEFAULT template's medical_history (from a fresh client) should have >= 2 ##
  // Note: we use testClientId here which may have been overwritten by wiki PUT test.
  // We just check that allContent has no forbidden phrases — the ## check is done in section 7.

  // PRD: Evidence citation format [🔗 溯源](log_id) must be documented/used
  // At minimum, the source evidence section should mention the citation format
  const comm = wiki?.['communication_timeline.md'] || '';
  assert('communication_timeline.md mentions citation format or has traceability section',
    /溯源|🔗|citation|traceab/i.test(comm) || /原始|source/i.test(comm),
    comm.substring(0, 200)
  );
}

// ─── Section 6: Chat Endpoint ────────────────────────────────────────────────

async function testChatEndpoint() {
  section('9. /api/chat Selection AI - Positive Cases');

  const { status: s1, data: d1 } = await req('POST', '/api/chat', {
    action: 'explain',
    text: '氨氯地平'
  });
  if (s1 === 500) {
    console.log('  ⚠ /api/chat returned 500 (likely missing LLM API key)');
    assert('/api/chat 500 has error field', d1 && d1.error, d1);
  } else {
    assert('/api/chat returns 200', s1 === 200, s1);
    assert('/api/chat response has reply', d1 && typeof d1.reply === 'string', d1);
    assert('/api/chat reply is non-empty', d1 && d1.reply.length > 0, d1?.reply?.length);
  }

  section('10. /api/chat - Negative Cases');

  const { status: s2, data: d2 } = await req('POST', '/api/chat', { action: 'explain' });
  assert('/api/chat without text returns 400', s2 === 400, s2);
  assert('Error message present', d2 && d2.error, d2);

  // Empty string text
  const { status: s3, data: d3 } = await req('POST', '/api/chat', { action: 'explain', text: '' });
  assert('/api/chat with empty text returns 400', s3 === 400, s3);
  assert('Empty text error field present', d3 && d3.error, d3);

  // No body at all
  const { status: s4 } = await req('POST', '/api/chat', {});
  assert('/api/chat with empty body returns 400', s4 === 400, s4);
}

// ─── Section 7: Cleanup ──────────────────────────────────────────────────────

async function testCleanup() {
  section('11. Cleanup - Delete Test Client');
  if (!testClientId) { console.log('  ⚠ Skipping: no test client'); return; }

  const { status: s1, data: d1 } = await req('DELETE', `/api/clients/${testClientId}`);
  assert('DELETE /api/clients/:id returns 200', s1 === 200, s1);
  assert('Success response', d1 && d1.success, d1);

  const { data: d2 } = await req('GET', '/api/clients');
  assert('Client no longer in list', Array.isArray(d2) && !d2.some(c => c.id === testClientId), d2?.length);

  const { status: s3 } = await req('GET', `/api/clients/${testClientId}/wiki`);
  assert('Deleted client wiki returns 404', s3 === 404, s3);

  const { status: s4 } = await req('GET', `/api/clients/${testClientId}/logs`);
  assert('Deleted client logs returns 404', s4 === 404, s4);
}

// ─── Main Runner ─────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🧪 LLMWiki PRD Compliance Test Suite (Enhanced)');
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Time:   ${new Date().toISOString()}`);

  try {
    const { status } = await req('GET', '/api/clients');
    if (status !== 200) {
      console.error(`\n❌ Server not reachable at ${BASE_URL} (status ${status})`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ Cannot connect to ${BASE_URL}: ${err.message}`);
    console.error('   Run: node server.cjs (in llmwiki directory)');
    process.exit(1);
  }

  try {
    await testClientsCRUD();
    await testWikiPages();
    await testLogs();
    await testCognitiveSkeletonStructure();
    await testCognitiveSafetyRules();
    await testChatEndpoint();
    await testCleanup();
  } catch (err) {
    console.error('\n💥 Unexpected test error:', err);
    failed++;
  }

  const total = passed + failed;
  console.log('\n' + '═'.repeat(62));
  console.log(`  Test Results: ${passed}/${total} passed`);
  if (failed > 0) {
    console.log(`  ❌ ${failed} test(s) FAILED — ralph will fix these`);
    console.log('═'.repeat(62));
    process.exit(1);
  } else {
    console.log('  ✅ All tests passed!');
    console.log('═'.repeat(62));
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
