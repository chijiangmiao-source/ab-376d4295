'use strict';

/**
 * 受限脚本的线性令牌流分析器。
 *
 * 语义模型
 * --------
 *  - token 声明产生一个具名物理令牌，规范类型为 `令牌(<名>)`；
 *  - let 绑定与函数形参都是别名：多个变量可指向同一个物理令牌；
 *  - let 多态：匿名函数无类型标注，每次调用按实参令牌的规范类型实例化形参，
 *    同一函数可在不同调用点以不同类型实参复用；
 *  - consume 一个变量时，其指向的物理令牌必须存活且唯一；程序结束时每个
 *    物理令牌都必须在每条可达路径上恰好消费一次；
 *  - 匿名函数按词法作用域捕获外层令牌；闭包内与闭包外对同一物理令牌的两次
 *    消费构成冲突，错误中给出变量跨度（声明点→末次消费点）与冲突路径；
 *  - if (令牌) 是守卫分叉：守卫令牌在分叉前已被消费时，真分支不可达，仅按
 *    可达的假分支裁决；两个分支都可达时，分叉执行并要求：
 *      1) 两分支消费数量相同；
 *      2) 分支结束时可见的剩余令牌多重集合（按规范类型）一致；
 *    合一后，分支后的剩余令牌集合作为 if 的值交给 let；
 *  - 调用既是语句也可作为 let 右值；函数返回值 = 函数体结束时仍存活的、由
 *    本次调用引入的令牌（形参与局部令牌）集合，并与调用点状态统一。
 */

const crypto = require('crypto');

let SEQ = 0;
const nextId = () => `T#${(++SEQ).toString(16)}`;

class AnalysisError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'AnalysisError';
    this.detail = detail;
  }
}

const loc = (n) => (n ? `第 ${n.line} 行第 ${n.column} 列` : '未知位置');
const locPair = (n) => (n ? { line: n.line, column: n.column } : null);
const posGe = (a, b) => a.line > b.line || (a.line === b.line && a.column >= b.column);

function multisetFrom(types) {
  const m = new Map();
  for (const t of types) m.set(t, (m.get(t) || 0) + 1);
  return m;
}
function sameMultiset(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
function formatMultiset(m) {
  const parts = [];
  for (const [t, n] of [...m.entries()].sort()) parts.push(n > 1 ? `${t}×${n}` : t);
  return parts.length ? `{ ${parts.join(', ')} }` : '{ }（空）';
}
function multisetList(m) {
  return [...m.entries()].sort().map(([type, count]) => ({ type, count }));
}

/** 词法环境：名字 -> 描述符 */
class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }
  declare(name, desc) {
    if (this.bindings.has(name)) {
      throw new AnalysisError(`变量 "${name}" 在同一作用域重复声明`);
    }
    this.bindings.set(name, desc);
  }
  resolve(name) {
    let s = this;
    while (s) {
      if (s.bindings.has(name)) return { scope: s, desc: s.bindings.get(name) };
      s = s.parent;
    }
    return null;
  }
  *allBindings() {
    let s = this;
    while (s) {
      for (const [name, desc] of s.bindings) yield { name, desc };
      s = s.parent;
    }
  }
}

/** 线性令牌状态，支持 if 分叉的写时复制覆盖层。 */
class LinState {
  constructor(parent = null) {
    this.parent = parent;
    this.local = new Map(); // id -> record
  }
  get(id) {
    if (this.local.has(id)) return this.local.get(id);
    return this.parent ? this.parent.get(id) : null;
  }
  set(id, rec) { this.local.set(id, rec); }
}

function analyze(ast) {
  SEQ = 0;
  const tokens = new Map(); // id -> 物理令牌元数据
  const rootState = new LinState();
  let state = rootState;
  const callStack = [];
  const callRecords = [];
  const branchRecords = [];

  function registerToken(typeName, defSite, origin) {
    const id = nextId();
    tokens.set(id, {
      id,
      type: `令牌(${typeName})`,
      typeName,
      defSite,
      origin,
      trail: [{ kind: '声明', at: defSite }],
      fate: null, // 'consumed-branch' | 'merged-alternative'
      branchSites: null,
    });
    state.set(id, { status: 'live' });
    return id;
  }

  const viaSnapshot = () => callStack.map((f) => ({
    functionSite: locPair(f.closureSite),
    functionSiteText: loc(f.closureSite),
    callSite: locPair(f.callSite),
    callSiteText: loc(f.callSite),
  }));
  const viaText = (via) =>
    via && via.length
      ? via.map((v) => `经定义于 ${v.functionSiteText} 的闭包，于 ${v.callSiteText} 调用`).join('；')
      : '';

  function consumePhysical(id, atSite, label, pathTag = null) {
    const meta = tokens.get(id);
    let rec = state.get(id);
    const via = viaSnapshot();
    const event = { at: atSite, via, pathTag };

    if (rec && rec.status === 'consumed') {
      // 令牌已在 if 的两条分支上分别消费：以 then 路径消费点为首次消费点
      if (rec.branched && !rec.site) {
        rec = { site: rec.branched.then.site, via: rec.branched.then.via, pathTag: 'then' };
      }
      throwDoubleConsume(meta, rec, event, label);
    }
    state.set(id, {
      status: 'consumed',
      site: atSite,
      via,
      pathTag,
    });
  }

  function throwDoubleConsume(meta, firstRec, secondEvent, label) {
    const firstAt = firstRec.site;
    const secondAt = secondEvent.at;
    const endAt = posGe(secondAt, firstAt) ? secondAt : firstAt;
    const path = [];
    for (const e of meta.trail) {
      if (e.kind === '声明') path.push(`声明于 ${loc(e.at)}`);
      else if (e.kind === '别名') path.push(`在 ${loc(e.at)} 经 let 由 "${e.from}" 移交为 "${e.to}"`);
      else if (e.kind === '捕获') path.push(`在 ${loc(e.at)} 被匿名函数（${e.fnLabel}）按词法作用域捕获`);
      else if (e.kind === '形参实例化')
        path.push(`在 ${loc(e.at)} 调用时实参 "${e.arg}" 统一到形参 "${e.param}"（规范类型 ${meta.type}）`);
      else if (e.kind === '分支合一') path.push(`在 ${loc(e.at)} 经 if 分支合一`);
    }
    path.push(
      `首次消费于 ${loc(firstAt)}` +
      `${firstRec.via && firstRec.via.length ? `（${viaText(firstRec.via)}）` : ''}` +
      `${firstRec.pathTag ? `[路径 ${firstRec.pathTag}]` : ''}`,
    );
    path.push(
      `再次消费于 ${loc(secondAt)}` +
      `${secondEvent.via && secondEvent.via.length ? `（${viaText(secondEvent.via)}）` : ''}` +
      `${secondEvent.pathTag ? `[路径 ${secondEvent.pathTag}]` : ''}`,
    );

    throw new AnalysisError(
      `令牌 "${label}"（规范类型 ${meta.type}）被重复消费：` +
      `变量跨度 ${loc(meta.defSite)} 至 ${loc(endAt)}；冲突路径：${path.join(' → ')}`,
      {
        code: 'DOUBLE_CONSUME',
        variable: label,
        tokenType: meta.type,
        span: { start: locPair(meta.defSite), end: locPair(endAt) },
        spanText: `${loc(meta.defSite)} 至 ${loc(endAt)}`,
        conflictPath: path,
      },
    );
  }

  /** 按描述符消费（含分支合一视图、空集合、令牌束等）。 */
  function consumeDesc(desc, atSite, label) {
    if (desc.kind === 'token') {
      consumePhysical(desc.id, atSite, label);
      return;
    }
    if (desc.kind === 'merged') {
      for (const alt of desc.alternatives) {
        consumePhysical(alt.id, atSite, `${label}（路径 ${alt.path}）`, alt.path);
      }
      return;
    }
    const errors = {
      unit: ['CONSUME_EMPTY', `consume 目标 "${label}" 不持有任何令牌（if/调用返回的剩余集合为空，${loc(atSite)}）`],
      bundle: ['CONSUME_BUNDLE',
        `consume 目标 "${label}" 持有多个分支剩余令牌（${formatMultiset(new Map(desc.types.map((t) => [t.type, t.count])))}），无法整体消费（${loc(atSite)}）`],
      closure: ['CONSUME_NON_TOKEN', `consume 目标 "${label}" 是匿名函数而非令牌（${loc(atSite)}）`],
    };
    const e = errors[desc.kind];
    if (e) throw new AnalysisError(e[1], { code: e[0], variable: label, at: locPair(atSite) });
    throw new AnalysisError(`consume 目标 "${label}" 不可消费（${loc(atSite)}）`, {
      code: 'CONSUME_NON_TOKEN', variable: label, at: locPair(atSite),
    });
  }

  function expectToken(desc, what, atNode) {
    if (desc.kind !== 'token' && desc.kind !== 'merged') {
      throw new AnalysisError(`${what}必须是单个令牌（${loc(atNode)}；实际为 ${desc.kind}）`, {
        code: 'TYPE_MISMATCH', at: locPair(atNode),
      });
    }
  }

  // -------- 自由变量与词法捕获 --------
  function analyzeBodyFree(body, bound, free) {
    for (const s of body) {
      if (s.kind === 'token') bound.add(s.name);
      else if (s.kind === 'let') { analyzeExprFree(s.expr, bound, free); bound.add(s.name); }
      else if (s.kind === 'consume') { if (!bound.has(s.name)) free.add(s.name); }
      else if (s.kind === 'call') {
        if (!bound.has(s.callee)) free.add(s.callee);
        for (const a of s.args) if (!bound.has(a)) free.add(a);
      }
    }
  }
  function analyzeExprFree(e, bound, free) {
    if (e.kind === 'var') { if (!bound.has(e.name)) free.add(e.name); }
    else if (e.kind === 'call') {
      if (!bound.has(e.callee)) free.add(e.callee);
      for (const a of e.args) if (!bound.has(a)) free.add(a);
    } else if (e.kind === 'if') {
      if (!bound.has(e.cond.name)) free.add(e.cond.name);
      analyzeBodyFree(e.thenBody, new Set(bound), free);
      analyzeBodyFree(e.elseBody, new Set(bound), free);
    } else if (e.kind === 'func') {
      const inner = new Set(bound);
      for (const p of e.params) inner.add(p);
      analyzeBodyFree(e.body, inner, free);
    }
  }

  /** 在函数定义点标记其词法捕获的外层令牌（用于冲突路径）。 */
  function markCaptures(fnNode, scope, fnLabel) {
    const bound = new Set(fnNode.params);
    const free = new Set();
    analyzeBodyFree(fnNode.body, bound, free);
    for (const name of free) {
      const r = scope.resolve(name);
      if (r && r.desc.kind === 'token') {
        tokens.get(r.desc.id).trail.push({ kind: '捕获', at: fnNode, fnLabel });
      }
    }
  }

  // -------- 表达式 --------
  function evalExpr(expr, scope, letName = null) {
    if (expr.kind === 'var') {
      const r = scope.resolve(expr.name);
      if (!r) throw new AnalysisError(`变量 "${expr.name}" 未声明（${loc(expr)}）`, {
        code: 'UNDECLARED', variable: expr.name, at: locPair(expr),
      });
      return r.desc;
    }
    if (expr.kind === 'func') {
      const fnLabel = letName ? `绑定于 let "${letName}"` : '匿名函数';
      markCaptures(expr, scope, fnLabel);
      return { kind: 'closure', params: expr.params, body: expr.body, defEnv: scope, defSite: expr, label: fnLabel };
    }
    if (expr.kind === 'call') return evalCall(expr, scope);
    if (expr.kind === 'if') return evalIf(expr, scope);
    throw new AnalysisError(`不支持的表达式（${loc(expr)}）`);
  }

  // -------- 调用：形参实例化 + 返回剩余集合 --------
  function evalCall(callNode, scope) {
    const callee = scope.resolve(callNode.callee);
    if (!callee) throw new AnalysisError(`调用目标 "${callNode.callee}" 未声明（${loc(callNode)}）`, {
      code: 'UNDECLARED', variable: callNode.callee, at: locPair(callNode),
    });
    if (callee.desc.kind !== 'closure') {
      throw new AnalysisError(`"${callNode.callee}" 不是匿名函数（${loc(callNode)}）`, {
        code: 'NOT_CALLABLE', variable: callNode.callee, at: locPair(callNode),
      });
    }
    const fn = callee.desc;
    if (fn.params.length !== callNode.args.length) {
      throw new AnalysisError(
        `函数形参数量 ${fn.params.length} 与实参数量 ${callNode.args.length} 不一致（${loc(callNode)}）`,
        { code: 'ARITY', at: locPair(callNode), expected: fn.params.length, actual: callNode.args.length },
      );
    }
    const argInfo = callNode.args.map((argName) => {
      const r = scope.resolve(argName);
      if (!r) throw new AnalysisError(`实参 "${argName}" 未声明（${loc(callNode)}）`, {
        code: 'UNDECLARED', variable: argName, at: locPair(callNode),
      });
      expectToken(r.desc, `实参 "${argName}"`, callNode);
      if (r.desc.kind === 'token') return { name: argName, desc: r.desc, tokenType: tokens.get(r.desc.id).type };
      return { name: argName, desc: r.desc, tokenType: r.desc.type };
    });

    const callScope = new Scope(fn.defEnv);
    fn.params.forEach((param, i) => {
      const arg = argInfo[i];
      if (arg.desc.kind === 'merged') {
        callScope.declare(param, { kind: 'merged', type: arg.desc.type, alternatives: arg.desc.alternatives });
      } else {
        tokens.get(arg.desc.id).trail.push({
          kind: '形参实例化', at: callNode, arg: arg.name, param,
        });
        callScope.declare(param, { kind: 'token', id: arg.desc.id }); // 别名：统一函数实参
      }
    });

    callStack.push({ closureSite: fn.defSite, callSite: callNode });
    try {
      for (const s of fn.body) execStmt(s, callScope);
    } finally {
      callStack.pop();
    }

    // 返回值：本次调用作用域内仍存活的令牌（形参别名 / 函数内声明）
    const liveIds = collectLiveIds(callScope);
    const returnedRemaining = multisetList(multisetFrom([...liveIds].map((id) => tokens.get(id).type)));
    callRecords.push({
      callee: callNode.callee,
      functionSite: locPair(fn.defSite),
      callSite: locPair(callNode),
      arguments: argInfo.map((a) => ({ name: a.name, tokenType: a.tokenType })),
      parameters: fn.params.map((p, i) => ({ name: p, instantiatedType: argInfo[i].tokenType })),
      returnedRemaining,
    });
    return idsToDesc(liveIds);
  }

  /**
   * 收集“本作用域自身引入”（不含外层词法变量）且仍存活的令牌：
   *  - 调用作用域：形参（实参别名）与函数体内 let/token 绑定；
   *  - 分支作用域：分支内声明或分支内 let 绑定的令牌。
   * 捕获的外层令牌仍由其原名在调用点状态中统一裁决，不计入返回集合。
   */
  function collectLiveIds(scope) {
    const ids = new Set();
    const addDesc = (desc) => {
      if (desc.kind === 'token') {
        const rec = state.get(desc.id);
        if (!rec || rec.status === 'live') ids.add(desc.id);
      } else if (desc.kind === 'merged') {
        for (const alt of desc.alternatives) {
          const rec = state.get(alt.id);
          if (!rec || rec.status === 'live') ids.add(alt.id);
        }
      }
    };
    for (const desc of scope.bindings.values()) addDesc(desc);
    return ids;
  }

  /** 某状态下某作用域可见（含外层词法变量）且仍存活的全部物理令牌。 */
  function collectVisibleLiveIds(scope) {
    const ids = new Set();
    const addDesc = (desc) => {
      if (desc.kind === 'token') {
        const rec = state.get(desc.id);
        if (!rec || rec.status === 'live') ids.add(desc.id);
      } else if (desc.kind === 'merged') {
        for (const alt of desc.alternatives) {
          const rec = state.get(alt.id);
          if (!rec || rec.status === 'live') ids.add(alt.id);
        }
      }
    };
    let s = scope;
    while (s) {
      for (const desc of s.bindings.values()) addDesc(desc);
      s = s.parent;
    }
    return ids;
  }

  function idsToDesc(ids) {
    if (ids.size === 0) return { kind: 'unit' };
    const list = [...ids];
    if (ids.size === 1) return { kind: 'token', id: list[0] };
    return {
      kind: 'bundle',
      types: multisetList(multisetFrom(list.map((id) => tokens.get(id).type))),
      total: list.length,
    };
  }

  // -------- if 分叉 --------
  function evalIf(ifNode, scope) {
    const guard = scope.resolve(ifNode.cond.name);
    if (!guard) throw new AnalysisError(`if 条件变量 "${ifNode.cond.name}" 未声明（${loc(ifNode.cond)}）`, {
      code: 'UNDECLARED', variable: ifNode.cond.name, at: locPair(ifNode.cond),
    });
    expectToken(guard.desc, 'if 条件', ifNode.cond);

    const guardIds = guard.desc.kind === 'token'
      ? [guard.desc.id]
      : guard.desc.alternatives.map((a) => a.id);
    const guardConsumed = guardIds.every((id) => {
      const r = state.get(id);
      return r && r.status === 'consumed';
    });

    // 真分支不可达：仅按可达的假分支在当前状态上裁决
    if (guardConsumed) {
      const child = new Scope(scope);
      const before = snapshotConsumedIds();
      for (const s of ifNode.elseBody) execStmt(s, child);
      const after = snapshotConsumedIds();
      const count = [...after].filter((id) => !before.has(id)).size;
      const visibleIds = collectVisibleLiveIds(child);
      const ownIds = collectLiveIds(child);
      const remaining = multisetList(multisetFrom([...visibleIds].map((id) => tokens.get(id).type)));
      branchRecords.push({
        at: locPair(ifNode),
        reachable: { then: false, else: true },
        adjudicatedPaths: ['else'],
        consumedCounts: { else: count },
        remaining: { else: remaining },
        unified: true,
      });
      const desc = idsToDesc(ownIds);
      if (desc.kind === 'token') tokens.get(desc.id).trail.push({ kind: '分支合一', at: ifNode });
      return desc;
    }

    const forkExec = (body) => {
      const saved = state;
      const fork = new LinState(state);
      state = fork;
      try {
        const child = new Scope(scope);
        for (const s of body) execStmt(s, child);
        return {
          fork,
          child,
          consumed: [...fork.local.entries()].filter(([, r]) => r.status === 'consumed'),
          visibleLiveIds: collectVisibleLiveIds(child), // 分支结束可见的剩余令牌（用于分支一致性裁决）
          ownLiveIds: collectLiveIds(child),           // 分支自身引入的剩余令牌（作为 if 返回值）
        };
      } finally {
        state = saved;
      }
    };

    const thenRes = forkExec(ifNode.thenBody);
    const elseRes = forkExec(ifNode.elseBody);
    const remainThen = multisetFrom([...thenRes.visibleLiveIds].map((id) => tokens.get(id).type));
    const remainElse = multisetFrom([...elseRes.visibleLiveIds].map((id) => tokens.get(id).type));

    if (thenRes.consumed.length !== elseRes.consumed.length || !sameMultiset(remainThen, remainElse)) {
      throw new AnalysisError(
        `if 两个可达分支结束状态不一致：消费数量 then=${thenRes.consumed.length}、` +
        `else=${elseRes.consumed.length}；分支结束的剩余令牌集合不一致：` +
        `then ${formatMultiset(remainThen)}，else ${formatMultiset(remainElse)}（${loc(ifNode)}）`,
        {
          code: 'BRANCH_MISMATCH',
          at: locPair(ifNode),
          consumedCounts: { then: thenRes.consumed.length, else: elseRes.consumed.length },
          remaining: { then: multisetList(remainThen), else: multisetList(remainElse) },
          remainingText: { then: formatMultiset(remainThen), else: formatMultiset(remainElse) },
        },
      );
    }

    mergeForks(thenRes, elseRes, scope);
    const desc = buildMergedDesc(thenRes, elseRes, ifNode);
    branchRecords.push({
      at: locPair(ifNode),
      reachable: { then: true, else: true },
      adjudicatedPaths: ['then', 'else'],
      consumedCounts: { then: thenRes.consumed.length, else: elseRes.consumed.length },
      remaining: { then: multisetList(remainThen), else: multisetList(remainElse) },
      unified: true,
    });
    return desc;
  }

  function snapshotConsumedIds() {
    const ids = new Set();
    const walk = (s) => {
      for (const [id, rec] of s.local.entries()) if (rec.status === 'consumed') ids.add(id);
      if (s.parent) walk(s.parent);
    };
    walk(state);
    return ids;
  }

  function mergeForks(a, b, outerScope) {
    const outerIds = new Set();
    for (const { desc } of outerScope.allBindings()) {
      if (desc.kind === 'token') outerIds.add(desc.id);
      if (desc.kind === 'merged') for (const alt of desc.alternatives) outerIds.add(alt.id);
    }
    const recA = new Map(a.consumed);
    const recB = new Map(b.consumed);
    const ids = new Set([...recA.keys(), ...recB.keys()]);
    for (const id of ids) {
      const ca = recA.has(id);
      const cb = recB.has(id);
      if (outerIds.has(id)) {
        // 剩余集合已保证两侧同生同死；两侧都消费 -> 合并为分支消费记录
        if (ca && cb) {
          state.set(id, {
            status: 'consumed',
            branched: { then: recA.get(id), else: recB.get(id) },
          });
        }
      } else {
        const meta = tokens.get(id);
        if (ca && cb) {
          meta.fate = 'consumed-branch';
          meta.branchSites = { then: locPair(recA.get(id).site), else: locPair(recB.get(id).site) };
        }
      }
    }
    // 分支局部存活令牌标记为合一备选
    for (const id of new Set([...a.ownLiveIds, ...b.ownLiveIds])) {
      if (!outerIds.has(id)) {
        const meta = tokens.get(id);
        if (meta.fate !== 'consumed-branch') meta.fate = 'merged-alternative';
      }
    }
  }

  function buildMergedDesc(thenRes, elseRes, ifNode) {
    const thenIds = thenRes.ownLiveIds;
    if (thenIds.size === 0) return { kind: 'unit' };
    if (thenIds.size === 1) {
      const idT = [...thenIds][0];
      const type = tokens.get(idT).type;
      const idE = [...elseRes.ownLiveIds].find((id) => tokens.get(id).type === type);
      for (const id of [idT, idE]) tokens.get(id).trail.push({ kind: '分支合一', at: ifNode });
      return {
        kind: 'merged',
        type,
        alternatives: [{ path: 'then', id: idT }, { path: 'else', id: idE }],
        at: ifNode,
      };
    }
    return {
      kind: 'bundle',
      types: multisetList(multisetFrom([...thenIds].map((id) => tokens.get(id).type))),
      total: thenIds.size,
    };
  }

  // -------- 语句 --------
  function execStmt(stmt, scope) {
    if (stmt.kind === 'token') {
      const id = registerToken(stmt.name, stmt, `令牌声明 "${stmt.name}"`);
      scope.declare(stmt.name, { kind: 'token', id });
      return;
    }
    if (stmt.kind === 'let') {
      const desc = evalExpr(stmt.expr, scope, stmt.name);
      if (desc.kind === 'token') {
        tokens.get(desc.id).trail.push({
          kind: '别名', at: stmt,
          from: stmt.expr.kind === 'var' ? stmt.expr.name : '<表达式>',
          to: stmt.name,
        });
      }
      scope.declare(stmt.name, desc);
      return;
    }
    if (stmt.kind === 'consume') {
      const r = scope.resolve(stmt.name);
      if (!r) throw new AnalysisError(`consume 目标 "${stmt.name}" 未声明（${loc(stmt)}）`, {
        code: 'UNDECLARED', variable: stmt.name, at: locPair(stmt),
      });
      consumeDesc(r.desc, stmt, stmt.name);
      return;
    }
    if (stmt.kind === 'call') {
      evalCall(stmt, scope);
      return;
    }
    throw new AnalysisError(`不支持的语句（${loc(stmt)}）`);
  }

  // -------- 主流程 --------
  const globalScope = new Scope();
  for (const s of ast) execStmt(s, globalScope);

  // 终态：每个物理令牌都必须被消费（分支备选在合一后消费也算消费）
  const leftovers = [];
  for (const [id, meta] of tokens) {
    if (meta.fate === 'consumed-branch') continue;
    const rec = rootState.get(id);
    if (!rec || rec.status !== 'consumed') leftovers.push(meta);
  }
  if (leftovers.length) {
    throw new AnalysisError(
      `程序结束仍有 ${leftovers.length} 个令牌未被消费：` +
      leftovers.map((m) => `${m.type}（声明于 ${loc(m.defSite)}）`).join('；'),
      {
        code: 'UNCONSUMED_TOKENS',
        tokens: leftovers.map((m) => ({ tokenType: m.type, at: locPair(m.defSite) })),
      },
    );
  }

  // 规范类型与每个令牌唯一的消费位置
  const normalizedTypes = new Set();
  const consumptionMap = [];
  const ordered = [...tokens.values()].sort(
    (a, b) => a.defSite.line - b.defSite.line || a.defSite.column - b.defSite.column,
  );
  for (const meta of ordered) {
    normalizedTypes.add(meta.type);
    if (meta.fate === 'consumed-branch') {
      consumptionMap.push({
        tokenType: meta.type,
        origin: meta.origin,
        declaredAt: locPair(meta.defSite),
        consumedInBranch: true,
        locationsByPath: {
          then: { location: meta.branchSites.then },
          else: { location: meta.branchSites.else },
        },
        note: `在 then / else 分支内分别唯一消费于 ` +
          `${meta.branchSites.then.line}:${meta.branchSites.then.column} 与 ` +
          `${meta.branchSites.else.line}:${meta.branchSites.else.column}`,
      });
      continue;
    }
    const rec = rootState.get(meta.id);
    if (!rec || rec.status !== 'consumed') continue;
    const entry = {
      tokenType: meta.type,
      origin: meta.origin,
      declaredAt: locPair(meta.defSite),
    };
    if (rec.branched) {
      entry.locationsByPath = {
        then: { location: locPair(rec.branched.then.site), via: rec.branched.then.via },
        else: { location: locPair(rec.branched.else.site), via: rec.branched.else.via },
      };
      entry.note = `then 路径唯一消费于 ${loc(rec.branched.then.site)}；else 路径唯一消费于 ${loc(rec.branched.else.site)}`;
    } else {
      entry.location = locPair(rec.site);
      entry.locationText = loc(rec.site);
      if (rec.via && rec.via.length) entry.via = rec.via;
    }
    consumptionMap.push(entry);
  }

  return {
    verdict: 'accept',
    normalizedTypes: [...normalizedTypes].sort(),
    consumptionMap,
    calls: callRecords,
    branches: branchRecords,
  };
}

/** 输入摘要：规范化后取 SHA-256，供结论固定保存与重传判定。 */
function summarize(source) {
  const normalized = source.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

module.exports = { analyze, summarize, AnalysisError, loc, locPair, formatMultiset };
