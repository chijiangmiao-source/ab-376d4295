'use strict';

const crypto = require('crypto');
const { parse, ParseError } = require('./parser');
const { analyze, summarize, AnalysisError } = require('./analyzer');

/** 由输入摘要派生稳定的默认审计标识。 */
function deriveAuditId(inputSummary) {
  return `AUD-${inputSummary.slice(0, 12).toUpperCase()}`;
}

function sanitizeAuditId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) return null;
  return trimmed;
}

/** 运行一次复核（不做持久化），返回规范化结论对象。 */
function review(source) {
  if (typeof source !== 'string' || source.length === 0 || !source.trim()) {
    return reject('EMPTY_INPUT', '提交内容为空：请粘贴受限脚本后再复核。', null);
  }
  if (source.length > 64 * 1024) {
    return reject('INPUT_TOO_LARGE', '提交内容超过 64KiB 限制。', null);
  }
  let ast;
  try {
    ast = parse(source);
  } catch (e) {
    if (e instanceof ParseError) {
      return reject('SYNTAX_ERROR', `脚本不满足受限文法：${e.message}`, {
        line: e.line || null,
        column: e.column || null,
      });
    }
    throw e;
  }
  try {
    const result = analyze(ast);
    return {
      verdict: 'accept',
      message: '合法的令牌移交：所有令牌在每条可达路径上恰好消费一次。',
      ...result,
    };
  } catch (e) {
    if (e instanceof AnalysisError) {
      return reject(e.detail && e.detail.code ? e.detail.code : 'ANALYSIS_ERROR', e.message, e.detail);
    }
    throw e;
  }
}

function reject(code, reason, detail) {
  return {
    verdict: 'reject',
    reasonCode: code,
    reason,
    detail: detail || null,
    normalizedTypes: [],
    consumptionMap: [],
  };
}

/** 固定保存的结论载荷（重开可原样读回）。 */
function buildConclusion(source) {
  const inputSummary = summarize(source);
  const conclusion = review(source);
  return { inputSummary, conclusion };
}

module.exports = { review, buildConclusion, deriveAuditId, sanitizeAuditId, summarize };
