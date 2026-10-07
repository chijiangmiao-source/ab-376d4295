'use strict';

/**
 * 受限脚本语言的词法分析与语法分析。
 *
 * 文法（EBNf；P 为程序，S 为语句，E 为表达式）：
 *
 *   P  := S*
 *   S  := TOKEN <ident> ';'                      // 令牌声明
 *       | CONSUME <ident> ';'                    // 令牌消费
 *       | LET <ident> '=' E ';'                  // let 绑定（值可为多态令牌对）
 *       | <ident> '(' args? ')' ';'              // 调用
 *   E  := <ident>                               // 变量引用
 *       | FUNCTION '(' params? ')' '{' S* '}'   // 匿名函数
 *       | IF '(' <ident> ')' '{' S* '}' ELSE '{' S* '}'
 *   args := <ident> (',' <ident>)*
 *
 * 程序顶层可以出现上述全部语句；函数体内同样允许令牌声明、消费、let、
 * 匿名函数定义（可嵌套）、调用与 if；if 的两个分支均为必填。
 */

const KEYWORDS = new Set(['token', 'consume', 'let', 'function', 'if', 'else']);

class SyntaxError_ extends Error {
  constructor(message, line, column) {
    super(line != null ? `第 ${line} 行第 ${column} 列: ${message}` : message);
    this.name = 'ParseError';
    this.line = line;
    this.column = column;
  }
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);

  const push = (type, value, l, c) => tokens.push({ type, value, line: l, column: c });

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { i++; line++; col = 1; continue; }
    if (/\s/.test(ch)) { i++; col++; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const startLine = line;
      i += 2; col += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') { line++; col = 1; } else col++;
        i++;
      }
      if (i >= source.length) throw new SyntaxError_('块注释未闭合', startLine, 1);
      i += 2; col += 2;
      continue;
    }
    if (isIdentStart(ch)) {
      const l = line, c = col;
      let j = i + 1;
      while (j < source.length && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);
      col += j - i;
      i = j;
      if (KEYWORDS.has(word)) push(word.toUpperCase(), word, l, c);
      else push('IDENT', word, l, c);
      continue;
    }
    if ('(){};,='.includes(ch)) {
      push(ch, ch, line, col);
      i++; col++;
      continue;
    }
    throw new SyntaxError_(`非法字符 ${JSON.stringify(ch)}`, line, col);
  }
  push('EOF', null, line, col);
  return tokens;
}

function parse(source) {
  const toks = tokenize(source);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const at = (type) => toks[p].type === type;

  function expect(type, what) {
    if (!at(type)) {
      const t = peek();
      throw new SyntaxError_(`期望 ${what || type}，但遇到 ${describe(t)}`, t.line, t.column);
    }
    return next();
  }

  function describe(t) {
    if (t.type === 'EOF') return '程序结束';
    if (t.type === 'IDENT') return `标识符 "${t.value}"`;
    return `"${t.value}"`;
  }

  function parseIdent() {
    const t = expect('IDENT', '标识符');
    return { name: t.value, line: t.line, column: t.column };
  }

  function parseParams() {
    const names = [];
    expect('(');
    if (!at(')')) {
      names.push(parseIdent().name);
      while (at(',')) {
        next();
        names.push(parseIdent().name);
      }
    }
    expect(')');
    return names;
  }

  // E := ident | function(...) { S* } | if (ident) { S* } else { S* }
  function parseExpr() {
    const t = peek();
    if (t.type === 'FUNCTION') {
      next();
      const params = parseParams();
      expect('{');
      const body = [];
      while (!at('}')) body.push(parseStmt());
      expect('}');
      const dup = params.find((n, i) => params.indexOf(n) !== i);
      if (dup) throw new SyntaxError_(`函数参数 "${dup}" 重复声明`, t.line, t.column);
      return { kind: 'func', params, body, line: t.line, column: t.column };
    }
    if (t.type === 'IF') {
      next();
      expect('(');
      const cond = parseIdent();
      expect(')');
      expect('{');
      const thenBody = [];
      while (!at('}')) thenBody.push(parseStmt());
      expect('}');
      expect('ELSE', '"else"');
      expect('{');
      const elseBody = [];
      while (!at('}')) elseBody.push(parseStmt());
      expect('}');
      return { kind: 'if', cond, thenBody, elseBody, line: t.line, column: t.column };
    }
    const v = parseIdent();
    if (at('(')) {
      // 调用表达式：可作为 let 右值
      const args = [];
      next();
      if (!at(')')) {
        args.push(parseIdent().name);
        while (at(',')) { next(); args.push(parseIdent().name); }
      }
      expect(')');
      return { kind: 'call', callee: v.name, args, line: v.line, column: v.column };
    }
    return { kind: 'var', name: v.name, line: v.line, column: v.column };
  }

  // S := token x; | consume x; | let x = E; | ident(args);
  function parseStmt() {
    const t = peek();
    if (t.type === 'TOKEN') {
      next();
      const name = parseIdent();
      expect(';');
      return { kind: 'token', name: name.name, line: t.line, column: t.column };
    }
    if (t.type === 'CONSUME') {
      next();
      const name = parseIdent();
      expect(';');
      return { kind: 'consume', name: name.name, line: t.line, column: t.column };
    }
    if (t.type === 'LET') {
      next();
      const name = parseIdent();
      expect('=');
      const expr = parseExpr();
      expect(';');
      return { kind: 'let', name: name.name, expr, line: t.line, column: t.column };
    }
    if (t.type === 'IDENT') {
      const callee = parseIdent();
      const args = [];
      expect('(');
      if (!at(')')) {
        args.push(parseIdent().name);
        while (at(',')) { next(); args.push(parseIdent().name); }
      }
      expect(')');
      expect(';');
      return { kind: 'call', callee: callee.name, args, line: callee.line, column: callee.column };
    }
    throw new SyntaxError_(`期望语句（token/consume/let/调用），但遇到 ${describe(t)}`, t.line, t.column);
  }

  const program = [];
  while (!at('EOF')) program.push(parseStmt());
  return program;
}

module.exports = { parse, tokenize, ParseError: SyntaxError_ };
