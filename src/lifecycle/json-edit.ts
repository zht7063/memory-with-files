// Strict JSON reading and format-preserving serialisation for config files we edit (hooks.json).
//
// The document must be strict JSON: comments, a BOM, trailing commas, duplicate keys and anything
// after the value are refused with a line and column, never "repaired". Re-serialising keeps the
// file's indentation style, line endings and final newline. It does not keep the exact layout of
// values (e.g. an array written on one line is expanded) or number spellings (1.0 becomes 1); the
// caller proves that nothing but its own entries changed by comparing parsed values.

export class JsonSyntaxError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'JsonSyntaxError';
    this.line = line;
    this.column = column;
  }
}

/** Validate strict JSON (with duplicate-key detection) and return the parsed value. */
export function parseStrictJson(text: string): unknown {
  let i = 0;
  const fail = (message: string, at = i): never => {
    let line = 1;
    let column = 1;
    for (let k = 0; k < at && k < text.length; k++) {
      if (text[k] === '\n') {
        line++;
        column = 1;
      } else column++;
    }
    throw new JsonSyntaxError(message, line, column);
  };
  if (text.charCodeAt(0) === 0xfeff) fail('a byte order mark is not allowed', 0);
  const ws = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
    if (text[i] === '/') fail('comments are not allowed');
  };
  const string = (): string => {
    const start = i;
    i++; // opening quote
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return JSON.parse(text.slice(start, i)) as string;
      }
      if (c === '\\') i += 2;
      else if (c < ' ') fail('control character in string');
      else i++;
    }
    return fail('unterminated string', start);
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const keys = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a string key');
        const at = i;
        const key = string();
        if (keys.has(key)) fail(`duplicate key "${key}"`, at);
        keys.add(key);
        ws();
        if (text[i] !== ':') fail("expected ':'");
        i++;
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        fail("expected ',' or '}'");
      }
    } else if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        fail("expected ',' or ']'");
      }
    } else if (c === '"') {
      string();
    } else {
      const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
        text.slice(i),
      );
      if (!m) fail(c === '/' ? 'comments are not allowed' : 'unexpected character');
      else i += m[0].length;
    }
  };
  value();
  ws();
  if (i < text.length) fail('unexpected content after the JSON value');
  return JSON.parse(text);
}

export interface JsonStyle {
  indent: string;
  eol: string;
  finalNewline: boolean;
}

export function detectStyle(text: string): JsonStyle {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m ? (m[1]!.startsWith('\t') ? '\t' : ' '.repeat(Math.min(m[1]!.length, 8))) : '  ';
  return { indent, eol, finalNewline: text.length === 0 ? true : /\n$/.test(text) };
}

export function serializeJson(value: unknown, style: JsonStyle): string {
  const body = JSON.stringify(value, null, style.indent);
  return (
    (style.eol === '\n' ? body : body.replace(/\n/g, style.eol)) +
    (style.finalNewline ? style.eol : '')
  );
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, k) => deepEqual(x, bb[k]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao);
  const kb = Object.keys(bo);
  return (
    ka.length === kb.length && ka.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]))
  );
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
