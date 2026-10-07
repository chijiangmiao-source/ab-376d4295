'use strict';
// 受限 DSL 词法分析器
// 允许的输入仅包含：令牌声明 token x;、consume(x);、let、匿名函数、调用、if、花括号/分号与标识符
// 注释（// 与 /* */）与空白仅作为分隔符，不携带语义。

const KEYWORDS = new Set(['token', 'consume', 'let', 'fn', 'if', 'else', 'true', 'false']);

class LexError extends Error {
  constructor(message, pos) {
    super(`${message}（位置 ${pos}）`);
    this.pos = pos;
  }
}

function isIdentStart(ch) {
  return /[A-Za-z_$]/.test(ch);
}
function isIdentPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}
function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function lex(source) {
  const tokens = [];
  let i = 0;
  const n = source.length;

  function push(type, value, start) {
    tokens.push({ type, value, start, end: i });
  }

  while (i < n) {
    const ch = source[i];

    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    // 行注释
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    // 块注释
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      let closed = false;
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new LexError('未闭合的块注释', i);
      continue;
    }

    const start = i;

    // 标识符 / 关键字
    if (isIdentStart(ch)) {
      i++;
      while (i < n && isIdentPart(source[i])) i++;
      const word = source.slice(start, i);
      if (isDigit(word[0])) throw new LexError('非法标识符', start);
      push(KEYWORDS.has(word) ? 'kw' : 'ident', word, start);
      continue;
    }

    // 数字在本 DSL 中非法（除了出现在标识符中段），给出明确报错
    if (isDigit(ch)) {
      throw new LexError('受限脚本不允许数字字面量', start);
    }

    // 标点
    const multi2 = source.slice(i, i + 2);
    if (multi2 === '==') { i += 2; push('op', '==', start); continue; }

    if ('(){};,'.includes(ch)) {
      i++;
      push('punct', ch, start);
      continue;
    }
    if (ch === '=' || ch === '!') {
      // 仅允许分支条件使用 !name（取反）
      i++;
      push('op', ch, start);
      continue;
    }
    if (ch === '&' || ch === '|') {
      if (source[i + 1] === ch) { i += 2; push('op', ch + ch, start); continue; }
      throw new LexError('受限脚本不允许该运算符', start);
    }

    throw new LexError(`受限脚本不允许的字符 "${ch}"`, start);
  }

  tokens.push({ type: 'eof', value: '<eof>', start: n, end: n });
  return tokens;
}

module.exports = { lex, KEYWORDS, LexError };
