'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ConclusionStore } = require('./store');
const {
  review, summarize, deriveAuditId, sanitizeAuditId,
} = require('./review');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'conclusions.json');

const store = new ConclusionStore(DATA_FILE);
const startedAt = new Date().toISOString();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function locText(l) {
  return l ? `第 ${l.line} 行第 ${l.column} 列` : '—';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /healthz' || route === 'GET /health') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'token-handoff-review',
        startedAt,
        records: store.list().length,
      });
    }

    if (route === 'GET /' || route === 'GET /index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (route === 'GET /api/reviews') {
      return sendJson(res, 200, { records: store.list() });
    }

    if (route.startsWith('GET /api/reviews/')) {
      const auditId = decodeURIComponent(url.pathname.slice('/api/reviews/'.length));
      const record = store.get(auditId);
      if (!record) return sendJson(res, 404, { error: 'NOT_FOUND', auditId });
      return sendJson(res, 200, record);
    }

    if (route === 'POST /api/reviews') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { error: 'BAD_JSON', message: '请求体必须是 JSON。' });
      }
      const script = body.script;
      if (typeof script !== 'string') {
        return sendJson(res, 400, { error: 'BAD_REQUEST', message: '字段 script 必须为字符串。' });
      }
      const inputSummary = summarize(script);
      let auditId = body.auditId != null && body.auditId !== '' ? sanitizeAuditId(body.auditId) : null;
      if (body.auditId != null && body.auditId !== '' && !auditId) {
        return sendJson(res, 400, {
          error: 'BAD_AUDIT_ID',
          message: '审计标识仅允许 1-64 位字母、数字、点、下划线或短横线，且以字母或数字开头。',
        });
      }
      if (!auditId) auditId = deriveAuditId(inputSummary);

      const existing = store.get(auditId);
      if (existing) {
        if (existing.inputSummary === inputSummary) {
          return sendJson(res, 200, {
            auditId,
            inputSummary,
            reused: true,
            overwritten: false,
            conclusion: existing.conclusion,
          });
        }
        return sendJson(res, 409, {
          error: 'AUDIT_ID_REUSED',
          message: `审计标识 ${auditId} 已绑定另一输入（摘要 ${existing.inputSummary.slice(0, 16)}…），拒绝复用且不改写旧结论。`,
          auditId,
          existingInputSummary: existing.inputSummary,
          attemptedInputSummary: inputSummary,
          existingConclusion: existing.conclusion,
        });
      }

      const conclusion = review(script);
      const { status } = store.submit(auditId, inputSummary, conclusion);
      return sendJson(res, status === 'stored' ? 201 : 200, {
        auditId,
        inputSummary,
        reused: false,
        overwritten: false,
        conclusion,
      });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    if (e && e.message === 'PAYLOAD_TOO_LARGE') {
      return sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE', message: '请求体过大。' });
    }
    // eslint-disable-next-line no-console
    console.error('server error:', e);
    sendJson(res, 500, { error: 'INTERNAL', message: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`token-handoff-review listening on http://${HOST}:${PORT} (data: ${DATA_FILE})`);
});

module.exports = { server, store, locText };
