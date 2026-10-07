'use strict';

/**
 * verify 的 HTTP/API 冒烟部分：
 * 以临时数据文件启动真实 HTTP 服务（Node 子进程），覆盖
 * 健康端点、页面、保存结论、相同内容重传、标识复用冲突、按标识读回，
 * 并重启服务验证持久化。任一项失败即以非零退出码结束。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 4791 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'review-smoke-'));
const DATA_FILE = path.join(DATA_DIR, 'conclusions.json');

let failures = 0;
let checks = 0;
function check(name, cond, extra = '') {
  checks++;
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

const SAMPLES = {
  legal: `token cmd;
let f = function (x) {
  consume x;
};
f(cmd);`,
  closure: `token key;
let g = function () {
  consume key;
};
g();
consume key;`,
  imbalance: `token a;
token flag;
let r = if (flag) {
  consume a;
} else {
};
consume r;`,
  other: `token other;
consume other;`,
};

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_FILE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('listening')) resolve(child);
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    setTimeout(() => reject(new Error('server start timeout: ' + out)), 8000);
  });
}

async function stopServer(child) {
  await new Promise((res) => {
    child.on('exit', res);
    child.kill('SIGTERM');
    setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000);
  });
}

async function req(method, urlPath, body) {
  const resp = await fetch(BASE + urlPath, {
    method,
    headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 页面非 JSON */ }
  return { status: resp.status, json, text };
}

async function main() {
  console.log('[smoke] 第 1 次启动服务（空数据）');
  let server = await startServer();
  let legalId;
  try {
    let r = await req('GET', '/healthz');
    check('GET /healthz 返回 200 且 status=ok', r.status === 200 && r.json.status === 'ok');

    r = await req('GET', '/health');
    check('GET /health 别名可用', r.status === 200 && r.json.service === 'token-handoff-review');

    r = await req('GET', '/');
    check('GET / 返回复核页面', r.status === 200 && r.text.includes('飞控令牌移交复核台'));

    r = await req('POST', '/api/reviews', { script: SAMPLES.legal, auditId: 'SMOKE-LEGAL' });
    check('合法移交样例 201 且 accept',
      r.status === 201 && r.json.conclusion.verdict === 'accept',
      `status=${r.status}`);
    check('合法结论含规范类型 令牌(cmd)',
      JSON.stringify(r.json.conclusion.normalizedTypes) === '["令牌(cmd)"]');
    check('合法结论含每个令牌唯一消费位置',
      Array.isArray(r.json.conclusion.consumptionMap) && r.json.conclusion.consumptionMap.length === 1 &&
      !!r.json.conclusion.consumptionMap[0].via);
    legalId = r.json.auditId;

    r = await req('POST', '/api/reviews', { script: SAMPLES.legal, auditId: 'SMOKE-LEGAL' });
    check('相同内容重传 200 且 reused=true', r.status === 200 && r.json.reused === true);
    check('重传返回原结论（消费映射一致）',
      r.json.conclusion.consumptionMap.length === 1 &&
      r.json.conclusion.normalizedTypes[0] === '令牌(cmd)');

    r = await req('POST', '/api/reviews', { script: SAMPLES.closure, auditId: 'SMOKE-CLOSURE' });
    check('闭包捕获冲突样例被拒绝',
      r.status === 201 && r.json.conclusion.verdict === 'reject' &&
      r.json.conclusion.reasonCode === 'DOUBLE_CONSUME');
    const d = r.json.conclusion.detail;
    check('拒绝载荷含变量跨度', !!(d && d.spanText && d.spanText.includes('至')));
    check('拒绝载荷含冲突路径（捕获→首次→再次）',
      !!(d && Array.isArray(d.conflictPath) &&
        d.conflictPath.some((p) => p.includes('捕获')) &&
        d.conflictPath.some((p) => p.includes('首次消费')) &&
        d.conflictPath.some((p) => p.includes('再次消费'))));

    r = await req('POST', '/api/reviews', { script: SAMPLES.imbalance, auditId: 'SMOKE-IMBAL' });
    check('分支不平衡样例被拒绝',
      r.json.conclusion && r.json.conclusion.verdict === 'reject' &&
      r.json.conclusion.reasonCode === 'BRANCH_MISMATCH');
    const dm = r.json.conclusion.detail;
    check('拒因给出两分支消费数量',
      dm && dm.consumedCounts.then === 1 && dm.consumedCounts.else === 0);
    check('拒因给出两分支结束剩余令牌集合',
      dm && JSON.stringify(dm.remaining.then).includes('令牌(flag)') &&
      JSON.stringify(dm.remaining.else).includes('令牌(a)') &&
      JSON.stringify(dm.remaining.else).includes('令牌(flag)'));

    r = await req('GET', `/api/reviews/${legalId}`);
    check('按审计标识读回原结论',
      r.status === 200 && r.record == null && r.json.auditId === legalId &&
      r.json.conclusion.normalizedTypes[0] === '令牌(cmd)' &&
      r.json.conclusion.consumptionMap.length === 1,
      `status=${r.status}`);

    r = await req('POST', '/api/reviews', { script: SAMPLES.other, auditId: 'SMOKE-LEGAL' });
    check('不同内容复用同一标识 → 409 AUDIT_ID_REUSED',
      r.status === 409 && r.json.error === 'AUDIT_ID_REUSED');

    r = await req('GET', `/api/reviews/${legalId}`);
    check('冲突后旧结论未被改写',
      r.json.conclusion.normalizedTypes[0] === '令牌(cmd)' &&
      r.json.conclusion.verdict === 'accept');

    r = await req('GET', '/api/reviews/NO-SUCH-ID');
    check('未知标识 404', r.status === 404 && r.json.error === 'NOT_FOUND');

    r = await req('GET', '/api/reviews');
    check('列表包含三条已保存结论（不含被拒提交的改写）',
      r.json.records.length === 3);
  } finally {
    await stopServer(server);
  }

  console.log('[smoke] 第 2 次启动服务（同数据文件，模拟重开）');
  server = await startServer();
  try {
    let r = await req('GET', '/healthz');
    check('重启后健康端点正常', r.status === 200 && r.json.status === 'ok');

    r = await req('GET', '/api/reviews/SMOKE-LEGAL');
    check('重开读回：原规范类型与消费映射',
      r.status === 200 && r.json.conclusion.normalizedTypes[0] === '令牌(cmd)' &&
      r.json.conclusion.consumptionMap.length === 1);

    r = await req('GET', '/api/reviews/SMOKE-CLOSURE');
    check('重开读回：原拒因（DOUBLE_CONSUME）与跨度',
      r.status === 200 && r.json.conclusion.reasonCode === 'DOUBLE_CONSUME' &&
      r.json.conclusion.detail.variable === 'key' &&
      !!r.json.conclusion.detail.spanText);

    r = await req('GET', '/api/reviews/SMOKE-IMBAL');
    check('重开读回：原拒因（BRANCH_MISMATCH）',
      r.status === 200 && r.json.conclusion.reasonCode === 'BRANCH_MISMATCH' &&
      r.json.conclusion.detail.consumedCounts.then === 1);

    r = await req('POST', '/api/reviews', { script: SAMPLES.legal, auditId: 'SMOKE-LEGAL' });
    check('重开后相同内容重传仍返回原结论', r.status === 200 && r.json.reused === true);
  } finally {
    await stopServer(server);
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n[smoke] 共 ${checks} 项，失败 ${failures} 项`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[smoke] 致命错误:', e);
  process.exit(2);
});
