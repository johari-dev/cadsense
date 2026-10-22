import type { Diagnostic } from "./Diagnostic.ts";
import type { SourceFile } from "./Source.ts";

/** Keywords per https://cad.onshape.com/FsDoc/tokens.html, plus `if`/`else`, which that list omits. */
export const KEYWORDS = new Set([
  "annotation",
  "enum",
  "export",
  "function",
  "import",
  "operator",
  "precondition",
  "predicate",
  "returns",
  "type",
  "typecheck",
  "typeconvert",
  "as",
  "is",
  "new",
  "break",
  "const",
  "continue",
  "for",
  "in",
  "return",
  "var",
  "while",
  "if",
  "else",
  "false",
  "inf",
  "true",
  "undefined",
  "catch",
  "throw",
  "try",
  "assert",
  "case",
  "default",
  "do",
  "switch",
] as const);
export type Keyword = typeof KEYWORDS extends Set<infer K> ? K : never;

/** Longest first, so the scanner can take the first match. */
const PUNCTUATORS = [
  "??=",
  "||=",
  "&&=",
  "?.",
  "?[",
  "::",
  "=>",
  "->",
  "<=",
  ">=",
  "==",
  "!=",
  "+=",
  "-=",
  "*=",
  "/=",
  "^=",
  "%=",
  "~=",
  "??",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "~",
  "<",
  ">",
  "!",
  "=",
  "?",
  ":",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ",",
  ";",
  ".",
] as const;
export type Punctuator = (typeof PUNCTUATORS)[number];

export type Token =
  | {
      readonly kind: "identifier";
      readonly value: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "builtin";
      readonly value: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "keyword";
      readonly value: Keyword;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "number";
      readonly value: number;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "string";
      readonly value: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "punctuator";
      readonly value: Punctuator;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "eof"; readonly value: ""; readonly start: number; readonly end: number };

const isIdentifierStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isIdentifierPart = (c: number) => isIdentifierStart(c) || isDigit(c);
const isKeyword = (word: string): word is Keyword => KEYWORDS.has(word as Keyword);
const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

/**
 * Splits a source file into tokens. Never throws: problems become diagnostics and the scanner
 * always advances, so a bad file still yields a token stream ending in `eof`.
 */
export function tokenize(file: SourceFile): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const text = file.text;
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;

  while (i < text.length) {
    const c = text.charCodeAt(i);
    // Whitespace: space, tab, newline, carriage return (and form feed / vertical tab, harmlessly).
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) {
      i++;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 47) {
      while (i < text.length && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) {
        diagnostics.push({
          code: "unterminated-comment",
          message: "This comment is never closed with */.",
          span: { start: i, end: i + 2 },
        });
        i = text.length;
      } else i = close + 2;
      continue;
    }
    const start = i;
    if (isIdentifierStart(c) || (c === 64 && isIdentifierStart(text.charCodeAt(i + 1)))) {
      i++;
      while (i < text.length && isIdentifierPart(text.charCodeAt(i))) i++;
      const word = text.slice(start, i);
      if (c === 64) tokens.push({ kind: "builtin", value: word.slice(1), start, end: i });
      else if (isKeyword(word)) tokens.push({ kind: "keyword", value: word, start, end: i });
      else tokens.push({ kind: "identifier", value: word, start, end: i });
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
      while (isDigit(text.charCodeAt(i))) i++;
      if (text.charCodeAt(i) === 46 && isDigit(text.charCodeAt(i + 1))) {
        i++;
        while (isDigit(text.charCodeAt(i))) i++;
      } else if (text.charCodeAt(i) === 46 && !isIdentifierStart(text.charCodeAt(i + 1))) i++; // `1.`
      if (text.charCodeAt(i) === 101 || text.charCodeAt(i) === 69) {
        const sign = text.charCodeAt(i + 1) === 43 || text.charCodeAt(i + 1) === 45 ? 1 : 0;
        if (isDigit(text.charCodeAt(i + 1 + sign))) {
          i += 1 + sign;
          while (isDigit(text.charCodeAt(i))) i++;
        }
      }
      if (isIdentifierPart(text.charCodeAt(i))) {
        while (isIdentifierPart(text.charCodeAt(i))) i++;
        diagnostics.push({
          code: "invalid-number",
          message: `"${text.slice(start, i)}" is not a number. Write units as multiplication, e.g. 5 * millimeter.`,
          span: { start, end: i },
        });
      }
      tokens.push({ kind: "number", value: Number(text.slice(start, i)), start, end: i });
      continue;
    }
    if (c === 34 || c === 39) {
      const quote = text[i]!;
      let value = "";
      i++;
      let closed = false;
      while (i < text.length) {
        const ch = text[i]!;
        if (ch === quote) {
          i++;
          closed = true;
          break;
        }
        if (ch === "\n" || ch === "\r") break;
        if (ch === "\\") {
          const next = text[i + 1];
          if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            value += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
            i += 6;
          } else if (next !== undefined && next in ESCAPES) {
            value += ESCAPES[next];
            i += 2;
          } else {
            // Keep the text; Onshape accepts some escapes it doesn't document (e.g. regex `\\.` is `\\` + `.`).
            diagnostics.push({
              code: "invalid-escape",
              message: `Unknown escape \\${next ?? ""} in a string.`,
              span: { start: i, end: i + 2 },
            });
            value += next ?? "";
            i += 2;
          }
          continue;
        }
        value += ch;
        i++;
      }
      if (!closed)
        diagnostics.push({
          code: "unterminated-string",
          message: "This string is never closed.",
          span: { start, end: i },
        });
      tokens.push({ kind: "string", value, start, end: i });
      continue;
    }
    const punctuator = PUNCTUATORS.find((p) => text.startsWith(p, i));
    // `?.` before a digit is a conditional with a number (`a ?.5 : 1`); `?[` only without a space.
    if (punctuator && !(punctuator === "?." && isDigit(text.charCodeAt(i + 2)))) {
      tokens.push({ kind: "punctuator", value: punctuator, start, end: i + punctuator.length });
      i += punctuator.length;
      continue;
    }
    if (punctuator === "?.") {
      tokens.push({ kind: "punctuator", value: "?", start, end: i + 1 });
      i++;
      continue;
    }
    const codePoint = text.codePointAt(i)!;
    const width = codePoint > 0xffff ? 2 : 1;
    diagnostics.push({
      code: "invalid-character",
      message: `Unexpected character "${String.fromCodePoint(codePoint)}". Non-ASCII text may only appear in strings and comments.`,
      span: { start, end: i + width },
    });
    i += width;
  }
  tokens.push({ kind: "eof", value: "", start: text.length, end: text.length });
  return { tokens, diagnostics };
}
