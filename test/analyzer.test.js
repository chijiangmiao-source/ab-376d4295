'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/parser');
const { analyze } = require('../src/analyzer');
const { review } = require('../src/review');
const { ConclusionStore } = require('../src/store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function run(src) {
  return analyze(parse(src));
}
function rejectCode(src) {
  try {
    run(src);
    return null;
  } catch (e) {
    return { code: e.detail && e.detail.code, error: e, detail: e.detail };
  }
}

// ---------- 1. 合法的令牌移交 ----------
test('合法移交：规范类型与每个令牌唯一消费位置', () => {
  const src = `
token cmd;
let f = function (x) {
  consume x;
};
f(cmd);
`;
  const r = run(src);
  assert.equal(r.verdict, 'accept');
  assert.deepEqual(r.normalizedTypes, ['令牌(cmd)']);
  assert.equal(r.consumptionMap.length, 1);
  const entry = r.consumptionMap[0];
  assert.equal(entry.tokenType, '令牌(cmd)');
  // 消费发生在闭包内，经调用到达
  assert.ok(entry.via.length >= 1, '应记录闭包→调用路径');
  assert.equal(entry.via[0].callSite.line, 6);
  // 调用统一：形参按实参实例化
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].parameters, [{ name: 'x', instantiatedType: '令牌(cmd)' }]);
  assert.deepEqual(r.calls[0].arguments, [{ name: 'cmd', tokenType: '令牌(cmd)' }]);
  assert.deepEqual(r.calls[0].returnedRemaining, []);
});

// ---------- 2. 闭包捕获后外层仍 consume ----------
test('闭包冲突：给出变量跨度与冲突路径', () => {
  const src = `
token key;
let g = function () {
  consume key;
};
g();
consume key;
`;
  const got = rejectCode(src);
  assert.equal(got.code, 'DOUBLE_CONSUME');
  assert.equal(got.detail.variable, 'key');
  assert.equal(got.detail.tokenType, '令牌(key)');
  // 变量跨度：声明（第 2 行）到末次消费（第 7 行）
  assert.deepEqual(got.detail.span.start, { line: 2, column: 1 });
  assert.deepEqual(got.detail.span.end, { line: 7, column: 1 });
  assert.match(got.detail.spanText, /第 2 行第 1 列 至 第 7 行第 1 列/);
  // 冲突路径包含捕获、首次（闭包内）、再次（外层）
  const p = got.detail.conflictPath.join(' | ');
  assert.match(p, /声明于/);
  assert.match(p, /按词法作用域捕获/);
  assert.match(p, /首次消费于.*第 4 行/);
  assert.match(p, /再次消费于.*第 7 行/);
});

test('页面与接口对同一冲突给出同一份跨度与路径（review 输出固定）', () => {
  const src = `token k;
let h = function () { consume k; };
h();
consume k;`;
  const a = review(src);
  const b = review(src);
  assert.equal(a.verdict, 'reject');
  assert.equal(a.reasonCode, 'DOUBLE_CONSUME');
  // 两次结论结构完全一致（接口 JSON 与页面渲染共用同一载荷）
  assert.deepEqual(a.detail, b.detail);
  assert.deepEqual(a.detail.span, {
    start: { line: 1, column: 1 },
    end: { line: 4, column: 1 },
  });
});

// ---------- 3. 两个可达分支消费数量不同 ----------
test('分支不平衡：拒绝并说明两支结束的剩余令牌集合', () => {
  const src = `
token a;
token flag;
let r = if (flag) {
  consume a;
} else {
};
consume r;
`;
  const got = rejectCode(src);
  assert.equal(got.code, 'BRANCH_MISMATCH');
  assert.deepEqual(got.detail.consumedCounts, { then: 1, else: 0 });
  const thenTypes = got.detail.remaining.then.map((t) => `${t.type}×${t.count}`).join(',');
  const elseTypes = got.detail.remaining.else.map((t) => `${t.type}×${t.count}`).join(',');
  assert.match(thenTypes, /令牌\(flag\)/);
  assert.ok(!thenTypes.includes('令牌(a)'), 'then 中 a 已消费');
  assert.match(elseTypes, /令牌\(flag\)/);
  assert.match(elseTypes, /令牌\(a\)/);
  assert.match(got.error.message, /分支结束的剩余令牌集合不一致/);
});

test('平衡分支：外层令牌两支各消费一次，按路径记录唯一消费位置', () => {
  const src = `
token flag;
token a;
let r = if (flag) {
  consume a;
} else {
  consume a;
};
consume flag;
`;
  const r = run(src);
  assert.equal(r.verdict, 'accept');
  const a = r.consumptionMap.find((e) => e.tokenType === '令牌(a)');
  assert.ok(a.locationsByPath, 'a 在两条路径各有唯一消费位置');
  assert.equal(a.locationsByPath.then.location.line, 5);
  assert.equal(a.locationsByPath.else.location.line, 7);
});

test('分支局部令牌经合一在分支后消费（每物理令牌唯一）', () => {
  const src = `
token flag;
token a;
let r = if (flag) {
  token b;
  consume a;
} else {
  token b;
  consume a;
};
consume r;
consume flag;
`;
  const r = run(src);
  assert.equal(r.verdict, 'accept');
  const bs = r.consumptionMap.filter((e) => e.tokenType === '令牌(b)');
  assert.equal(bs.length, 2, '两支各声明一个 b 物理令牌');
});

// ---------- 4. let 多态 ----------
test('let 多态：同一匿名函数以不同规范类型实参复用', () => {
  const src = `
token takeoff;
token land;
let relay = function (t) {
  consume t;
};
relay(takeoff);
relay(land);
`;
  const r = run(src);
  assert.equal(r.verdict, 'accept');
  assert.deepEqual(r.normalizedTypes, ['令牌(land)', '令牌(takeoff)']);
  assert.equal(r.calls[0].parameters[0].instantiatedType, '令牌(takeoff)');
  assert.equal(r.calls[1].parameters[0].instantiatedType, '令牌(land)');
});

// ---------- 5. 任一分支不可达，按可达路径裁决 ----------
test('守卫令牌已消费：then 不可达，仅按 else 裁决', () => {
  const src = `
token flag;
token cmd;
consume flag;
let r = if (flag) {
  consume cmd;
} else {
  consume cmd;
};
`;
  const r = run(src);
  assert.equal(r.verdict, 'accept');
  assert.equal(r.branches.length, 1);
  assert.deepEqual(r.branches[0].reachable, { then: false, else: true });
  assert.deepEqual(r.branches[0].adjudicatedPaths, ['else']);
});

test('then 不可达时，其中的过度消费不再参与裁决（else 合法即通过）', () => {
  const src = `
token flag;
token cmd;
consume flag;
let r = if (flag) {
  consume cmd;
  consume cmd;
} else {
  consume cmd;
};
`;
  const r = run(src);
  assert.equal(r.verdict, 'accept');
});

// ---------- 函数实参 / 返回值 / 分支后剩余集合统一 ----------
test('函数返回剩余令牌：未消费的实参经 let 在外层消费', () => {
  const src = `
token a;
let f = function (x) {
};
let r = f(a);
consume r;
`;
  const r = run(src);
  assert.equal(r.verdict, 'accept');
  assert.deepEqual(r.calls[0].returnedRemaining, [{ type: '令牌(a)', count: 1 }]);
});

test('形参消费与外层再消费冲突', () => {
  const src = `
token a;
let f = function (x) { consume x; };
f(a);
consume a;
`;
  assert.equal(rejectCode(src).code, 'DOUBLE_CONSUME');
});

test('遗留令牌必须拒绝', () => {
  const got = rejectCode(`token a;`);
  assert.equal(got.code, 'UNCONSUMED_TOKENS');
});

test('未声明变量消费必须拒绝', () => {
  assert.equal(rejectCode(`consume ghost;`).code, 'UNDECLARED');
});

test('实参数量不匹配必须拒绝', () => {
  const src = `token a;
let f = function (x, y) { consume x; consume y; };
f(a);`;
  assert.equal(rejectCode(src).code, 'ARITY');
});

test('let 别名移交后旧名再消费冲突', () => {
  const src = `
token a;
let b = a;
consume b;
consume a;
`;
  assert.equal(rejectCode(src).code, 'DOUBLE_CONSUME');
});

test('文法违例给出解析错误', () => {
  const out = review(`token ;`);
  assert.equal(out.verdict, 'reject');
  assert.equal(out.reasonCode, 'SYNTAX_ERROR');
});

test('空输入拒绝', () => {
  assert.equal(review('   \n').reasonCode, 'EMPTY_INPUT');
});

// ---------- 6. 持久化：重传幂等、标识复用拒绝且不改写 ----------
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-store-'));
  return new ConclusionStore(path.join(dir, 'c.json'));
}

test('相同内容重传返回原结论', () => {
  const store = tmpStore();
  const src = `token z;
let f = function (x) { consume x; };
f(z);`;
  const c1 = review(src);
  const s1 = store.submit('AUD-1', require('../src/review').summarize(src), c1);
  const s2 = store.submit('AUD-1', require('../src/review').summarize(src), c1);
  assert.equal(s1.status, 'stored');
  assert.equal(s2.status, 'returned');
  assert.strictEqual(s2.record, s1.record);
  const readBack = store.get('AUD-1');
  assert.equal(readBack.conclusion.verdict, 'accept');
  assert.deepEqual(readBack.conclusion.normalizedTypes, ['令牌(z)']);
  assert.equal(readBack.conclusion.consumptionMap.length, 1);
});

test('不同内容复用同一标识：拒绝且旧结论不变', () => {
  const store = tmpStore();
  const srcA = `token a;
let f = function (x) { consume x; };
f(a);`;
  const srcB = `token b;
consume b;`;
  const { summarize } = require('../src/review');
  store.submit('AUD-X', summarize(srcA), review(srcA));
  const res = store.submit('AUD-X', summarize(srcB), review(srcB));
  assert.equal(res.status, 'reused-mismatch');
  const old = store.get('AUD-X');
  assert.equal(old.inputSummary, summarize(srcA));
  assert.deepEqual(old.conclusion.normalizedTypes, ['令牌(a)']);
});

test('重开存储：从磁盘读回原类型、消费映射与拒因', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-store-'));
  const file = path.join(dir, 'nested', 'c.json');
  const s1 = new ConclusionStore(file);
  const bad = `token k;
let h = function () { consume k; };
h();
consume k;`;
  const { summarize } = require('../src/review');
  s1.submit('AUD-REJ', summarize(bad), review(bad));
  const s2 = new ConclusionStore(file);
  const rec = s2.get('AUD-REJ');
  assert.equal(rec.conclusion.verdict, 'reject');
  assert.equal(rec.conclusion.reasonCode, 'DOUBLE_CONSUME');
  assert.equal(rec.conclusion.detail.span.end.line, 4);
});
