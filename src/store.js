'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 结论持久化：按审计标识固定保存到单个 JSON 文件。
 *  - 相同内容（同输入摘要）重传：返回原结论；
 *  - 不同内容复用同一审计标识：拒绝，且绝不改写旧结论。
 */
class ConclusionStore {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const obj = JSON.parse(raw);
      this.records = new Map(Object.entries(obj.records || {}));
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.records = new Map();
        return;
      }
      throw e;
    }
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const obj = {
      version: 1,
      updatedAt: new Date().toISOString(),
      records: Object.fromEntries(this.records.entries()),
    };
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get(auditId) {
    return this.records.get(auditId) || null;
  }

  /**
   * @returns {{status: 'returned'|'stored'|'reused-mismatch', record?}}
   */
  submit(auditId, inputSummary, conclusion) {
    const existing = this.records.get(auditId);
    if (existing) {
      if (existing.inputSummary === inputSummary) {
        return { status: 'returned', record: existing, reused: true };
      }
      return { status: 'reused-mismatch', record: existing };
    }
    const record = {
      auditId,
      inputSummary,
      submittedAt: new Date().toISOString(),
      conclusion,
    };
    this.records.set(auditId, record);
    this._persist();
    return { status: 'stored', record };
  }

  list() {
    return [...this.records.values()].map((r) => ({
      auditId: r.auditId,
      inputSummary: r.inputSummary,
      submittedAt: r.submittedAt,
      verdict: r.conclusion.verdict,
    }));
  }
}

module.exports = { ConclusionStore };
