'use strict';
// 受限 DSL 语法分析器
//
// 文法（EBNF，仅支持以下构造）：
//   program  := stmt*
//   stmt     := tokenDecl | consumeStmt | letStmt | ifStmt | callStmt
//   tokenDecl:= 'token' IDENT ';'
//   consume  := 'consume' '(' IDENT ')' ';'
//   letStmt  := 'let' IDENT '=' expr ';'
//   ifStmt   := 'if' '(' cond ')' block ('else' (block | ifStmt))?
//   callStmt := IDENT '(' (IDENT (',' IDENT)*)? ')' ';'
//   expr     := fnExpr | callExpr | IDENT
//   fnExpr   := 'fn' '(' (IDENT (',' IDENT)*)? ')' block
//   block    := '{' stmt* '}'
//   cond     := orExpr            // 仅用于分支可达性判定
// 明确禁止：赋值、return、数字/字符串字面量、算术、while 等一切其它构造。

class ParseError extends Error {
  constructor(message, token) {
    const pos = token ? token.start : 0;
    super(`${message}（位置 ${pos}）`);
    this.pos = pos;
    this.token = token || null;
  }
}

function parse(tokens) {
  let p = 0;

  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const atEof = () => peek().type === 'eof';

  function isPunct(v) { return peek().type === 'punct' && peek().value === v; }
  function isKw(v) { return peek().type === 'kw' && peek().value === v; }

  function expectPunct(v) {
    const t = peek();
    if (t.type !== 'punct' || t.value !== v) {
      throw new ParseError(`期望 "${v}"，但遇到 "${t.value}"`, t);
    }
    p++;
    return t;
  }
  function expectKw(v) {
    const t = peek();
    if (t.type !== 'kw' || t.value !== v) {
      throw new ParseError(`期望关键字 "${v}"，但遇到 "${t.value}"`, t);
    }
    p++;
    return t;
  }
  function expectIdent() {
    const t = peek();
    if (t.type !== 'ident') {
      throw new ParseError(`期望标识符，但遇到 "${t.value}"`, t);
    }
    p++;
    return t;
  }

  function spanOf(startTok, endTok) {
    return { start: startTok.start, end: endTok.end };
  }

  function parseParams() {
    const names = [];
    const spans = [];
    expectPunct('(');
    if (!isPunct(')')) {
      for (;;) {
        const t = expectIdent();
        if (names.includes(t.value)) {
          throw new ParseError(`函数参数 "${t.value}" 重复`, t);
        }
        names.push(t.value);
        spans.push(spanOf(t, t));
        if (isPunct(',')) { p++; continue; }
        break;
      }
    }
    expectPunct(')');
    return { names, spans };
  }

  function parseBlock() {
    const open = expectPunct('{');
    const body = [];
    while (!isPunct('}') && !atEof()) {
      body.push(parseStmt());
    }
    const close = expectPunct('}');
    return { type: 'Block', body, span: spanOf(open, close) };
  }

  function parseFnExpr() {
    const kw = expectKw('fn');
    const { names: params, spans: paramSpans } = parseParams();
    const body = parseBlock();
    return { type: 'FnExpr', params, paramSpans, body, span: spanOf(kw, body.span) };
  }

  // 调用：IDENT ( args ) ；实参只允许标识符（令牌变量或函数变量由语义阶段裁决）
  function parseCallExpr(nameTok) {
    const args = [];
    const argToks = [];
    expectPunct('(');
    if (!isPunct(')')) {
      for (;;) {
        const t = expectIdent();
        args.push(t.value);
        argToks.push(t);
        if (isPunct(',')) { p++; continue; }
        break;
      }
    }
    const close = expectPunct(')');
    return {
      type: 'Call', callee: nameTok.value, calleeTok: nameTok,
      args, argToks, span: spanOf(nameTok, close),
    };
  }

  function parseExpr() {
    const t = peek();
    if (t.type === 'kw' && t.value === 'fn') return parseFnExpr();
    if (t.type !== 'ident') {
      throw new ParseError(`let 右侧只允许匿名函数、调用或变量引用，但遇到 "${t.value}"`, t);
    }
    p++;
    if (isPunct('(')) return parseCallExpr(t);
    return { type: 'Ident', name: t.value, tok: t, span: spanOf(t, t) };
  }

  function parseCond() {
    // or := and ('||' and)* ; and := unary ('&&' unary)* ; unary := '!' unary | primary
    function parsePrimary() {
      const t = peek();
      if (t.type === 'punct' && t.value === '(') {
        p++;
        const e = parseOr();
        expectPunct(')');
        return e;
      }
      if (t.type === 'kw' && (t.value === 'true' || t.value === 'false')) {
        p++;
        return { ct: 'Bool', value: t.value === 'true', span: spanOf(t, t) };
      }
      if (t.type !== 'ident') {
        throw new ParseError(`分支条件只允许布尔变量、true/false、!、&&、||，但遇到 "${t.value}"`, t);
      }
      p++;
      return { ct: 'Name', name: t.value, span: spanOf(t, t) };
    }
    function parseUnary() {
      const t = peek();
      if (t.type === 'op' && t.value === '!') {
        p++;
        const arg = parseUnary();
        return { ct: 'Not', arg, span: { start: t.start, end: arg.span.end } };
      }
      return parsePrimary();
    }
    function parseAnd() {
      let left = parseUnary();
      while (peek().type === 'op' && peek().value === '&&') {
        const op = next();
        const right = parseUnary();
        left = { ct: 'And', left, right, span: { start: left.span.start, end: right.span.end } };
      }
      return left;
    }
    function parseOr() {
      let left = parseAnd();
      while (peek().type === 'op' && peek().value === '||') {
        const op = next();
        const right = parseAnd();
        left = { ct: 'Or', left, right, span: { start: left.span.start, end: right.span.end } };
      }
      return left;
    }
    const expr = parseOr();
    return expr;
  }

  function parseStmt() {
    const t = peek();

    if (t.type === 'kw' && t.value === 'token') {
      p++;
      const nameTok = expectIdent();
      const semi = expectPunct(';');
      return {
        type: 'TokenDecl', name: nameTok.value, nameTok,
        span: spanOf(t, semi), nameSpan: spanOf(nameTok, nameTok),
      };
    }

    if (t.type === 'kw' && t.value === 'consume') {
      p++;
      expectPunct('(');
      const argTok = expectIdent();
      expectPunct(')');
      const semi = expectPunct(';');
      return {
        type: 'Consume', name: argTok.value, argTok,
        span: spanOf(t, semi), argSpan: spanOf(argTok, argTok),
      };
    }

    if (t.type === 'kw' && t.value === 'let') {
      p++;
      const nameTok = expectIdent();
      const eq = peek();
      if (eq.type !== 'op' || eq.value !== '=') {
        throw new ParseError('let 语句需要 "="（不允许任何形式的重新赋值）', eq);
      }
      p++;
      const value = parseExpr();
      const semi = expectPunct(';');
      return {
        type: 'Let', name: nameTok.value, nameTok, value,
        span: spanOf(t, semi), nameSpan: spanOf(nameTok, nameTok),
      };
    }

    if (t.type === 'kw' && t.value === 'if') {
      p++;
      expectPunct('(');
      const cond = parseCond();
      expectPunct(')');
      const thenBranch = parseBlock();
      let elseBranch = null;
      let endTok = thenBranch.span;
      if (isKw('else')) {
        p++;
        if (isKw('if')) {
          elseBranch = parseStmt();
        } else if (isPunct('{')) {
          elseBranch = parseBlock();
        } else {
          throw new ParseError('else 后必须是块或另一个 if', peek());
        }
        endTok = { start: thenBranch.span.start, end: elseBranch.span.end };
      }
      return { type: 'If', cond, thenBranch, elseBranch, span: { start: t.start, end: endTok.end } };
    }

    if (t.type === 'ident') {
      p++;
      if (!isPunct('(')) {
        throw new ParseError(`独立语句只能是调用，"${t.value}" 后期望 "("`, peek());
      }
      const call = parseCallExpr(t);
      const semi = expectPunct(';');
      call.span = spanOf(t, semi);
      call.statement = true;
      return call;
    }

    throw new ParseError(
      `受限脚本只允许 token/consume/let/匿名函数/调用/if 语句，但遇到 "${t.value}"`, t,
    );
  }

  const program = { type: 'Program', body: [], span: { start: 0, end: tokens[tokens.length - 1].end } };
  while (!atEof()) {
    program.body.push(parseStmt());
  }
  return program;
}

module.exports = { parse, ParseError };
