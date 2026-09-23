// SFML expression language (SPEC clause 7): a closed subset of CEL.
//
// Grammar (§7.2): field selection, indexing, comparison and boolean operators, literals, and calls
// into the standard function library of §7.4 (`last`, `empty`, `notEmpty`). No user-defined
// functions, no arithmetic on step results, no collection macros.
//
// This is a small hand-rolled parser rather than a CEL binding, per §7.1: "or MAY implement the
// subset of CEL this clause defines directly in a language with no usable CEL binding."

export type ExprValue = null | boolean | number | string | ExprValue[] | { [key: string]: ExprValue };

export class ExpressionError extends Error {}

// --- AST ------------------------------------------------------------------------------------

type Node =
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "ident"; name: string }
  | { kind: "member"; target: Node; name: string }
  | { kind: "index"; target: Node; index: Node }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "unary"; op: "!"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node };

// --- tokenizer --------------------------------------------------------------------------------

type Token = { kind: "ident" | "number" | "string" | "punct" | "eof"; text: string; value?: string | number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ kind: "ident", text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(src[j]!)) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < n && /[0-9]/.test(src[j]!)) j++;
      }
      const text = src.slice(i, j);
      tokens.push({ kind: "number", text, value: Number(text) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < n) {
          const esc = src[j + 1]!;
          out += { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" }[esc] ?? esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= n) throw new ExpressionError(`unterminated string literal in expression: ${src}`);
      tokens.push({ kind: "string", text: src.slice(i, j + 1), value: out });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      tokens.push({ kind: "punct", text: two });
      i += 2;
      continue;
    }
    if ("().[],!<>".includes(c)) {
      tokens.push({ kind: "punct", text: c });
      i++;
      continue;
    }
    throw new ExpressionError(`unexpected character '${c}' in expression: ${src}`);
  }
  tokens.push({ kind: "eof", text: "" });
  return tokens;
}

// --- parser (recursive descent, precedence climbing) -----------------------------------------

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expect(text: string): Token {
    const t = this.next();
    if (t.text !== text) throw new ExpressionError(`expected '${text}' but found '${t.text || "<eof>"}' in expression: ${this.source}`);
    return t;
  }

  parseProgram(): Node {
    const node = this.parseOr();
    if (this.peek().kind !== "eof") throw new ExpressionError(`unexpected trailing input in expression: ${this.source}`);
    return node;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek().text === "||") {
      this.next();
      left = { kind: "binary", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseUnary();
    while (this.peek().text === "&&") {
      this.next();
      left = { kind: "binary", op: "&&", left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.peek().text === "!") {
      this.next();
      return { kind: "unary", op: "!", operand: this.parseUnary() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Node {
    const left = this.parsePostfix();
    const op = this.peek().text;
    if (["==", "!=", "<", "<=", ">", ">="].includes(op)) {
      this.next();
      const right = this.parsePostfix();
      return { kind: "binary", op, left, right };
    }
    return left;
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.text === ".") {
        this.next();
        const name = this.next();
        if (name.kind !== "ident") throw new ExpressionError(`expected a field name after '.' in expression: ${this.source}`);
        node = { kind: "member", target: node, name: name.text };
      } else if (t.text === "[") {
        this.next();
        const index = this.parseOr();
        this.expect("]");
        node = { kind: "index", target: node, index };
      } else {
        break;
      }
    }
    return node;
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (t.kind === "number") return { kind: "number", value: t.value as number };
    if (t.kind === "string") return { kind: "string", value: t.value as string };
    if (t.text === "(") {
      const node = this.parseOr();
      this.expect(")");
      return node;
    }
    if (t.kind === "ident") {
      if (t.text === "true") return { kind: "bool", value: true };
      if (t.text === "false") return { kind: "bool", value: false };
      if (t.text === "null") return { kind: "null" };
      if (this.peek().text === "(") {
        this.next();
        const args: Node[] = [];
        if (this.peek().text !== ")") {
          args.push(this.parseOr());
          while (this.peek().text === ",") {
            this.next();
            args.push(this.parseOr());
          }
        }
        this.expect(")");
        return { kind: "call", name: t.text, args };
      }
      return { kind: "ident", name: t.text };
    }
    throw new ExpressionError(`unexpected token '${t.text || "<eof>"}' in expression: ${this.source}`);
  }
}

export function parseExpression(source: string): Node {
  return new Parser(tokenize(source), source).parseProgram();
}

/** Throws ExpressionError if `source` is not a syntactically valid SFML expression. */
export function checkExpressionSyntax(source: string): void {
  parseExpression(source);
}

// --- evaluation -------------------------------------------------------------------------------

const FUNCTIONS = new Set(["last", "empty", "notEmpty"]);

export type Env = Record<string, ExprValue>;

function isTruthy(v: ExprValue): boolean {
  if (typeof v === "boolean") return v;
  throw new ExpressionError(`expected a boolean, got ${JSON.stringify(v)}`);
}

function equal(a: ExprValue, b: ExprValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(op: string, a: ExprValue, b: ExprValue): boolean {
  if (op === "==") return equal(a, b);
  if (op === "!=") return !equal(a, b);
  if (typeof a !== "number" || typeof b !== "number") {
    if (typeof a === "string" && typeof b === "string") {
      switch (op) {
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
      }
    }
    throw new ExpressionError(`cannot compare with '${op}': ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
  throw new ExpressionError(`unknown comparison operator '${op}'`);
}

function callFunction(name: string, args: ExprValue[]): ExprValue {
  if (args.length !== 1) throw new ExpressionError(`${name}() takes exactly one argument`);
  const [arg] = args as [ExprValue];
  switch (name) {
    case "last": {
      if (arg === null) return null;
      if (!Array.isArray(arg)) throw new ExpressionError(`last() requires a list, got ${JSON.stringify(arg)}`);
      return arg.length === 0 ? null : arg[arg.length - 1]!;
    }
    case "empty": {
      if (arg === null) return true;
      if (typeof arg === "string" || Array.isArray(arg)) return arg.length === 0;
      throw new ExpressionError(`empty() requires a list, string, or null, got ${JSON.stringify(arg)}`);
    }
    case "notEmpty":
      return !(callFunction("empty", [arg]) as boolean);
  }
  throw new ExpressionError(`unknown function '${name}'`);
}

function evaluate(node: Node, env: Env): ExprValue {
  switch (node.kind) {
    case "null":
      return null;
    case "bool":
      return node.value;
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "ident": {
      if (!(node.name in env)) throw new ExpressionError(`unknown identifier '${node.name}'`);
      return env[node.name]!;
    }
    case "member": {
      const target = evaluate(node.target, env);
      if (target === null) return null; // §7.3: field access on null yields null
      if (typeof target !== "object" || Array.isArray(target)) throw new ExpressionError(`cannot select field '${node.name}' from ${JSON.stringify(target)}`);
      return Object.prototype.hasOwnProperty.call(target, node.name) ? target[node.name]! : null;
    }
    case "index": {
      const target = evaluate(node.target, env);
      const index = evaluate(node.index, env);
      if (target === null) return null;
      if (Array.isArray(target)) {
        if (typeof index !== "number" || !Number.isInteger(index)) throw new ExpressionError(`list index must be an integer, got ${JSON.stringify(index)}`);
        if (index < 0 || index >= target.length) throw new ExpressionError(`index ${index} out of range for a list of length ${target.length}`);
        return target[index]!;
      }
      if (typeof target === "object") {
        if (typeof index !== "string") throw new ExpressionError(`map index must be a string, got ${JSON.stringify(index)}`);
        return Object.prototype.hasOwnProperty.call(target, index) ? target[index]! : null;
      }
      throw new ExpressionError(`cannot index into ${JSON.stringify(target)}`);
    }
    case "call": {
      if (!FUNCTIONS.has(node.name)) throw new ExpressionError(`unknown function '${node.name}'`);
      const args = node.args.map((a) => evaluate(a, env));
      return callFunction(node.name, args);
    }
    case "unary":
      return !isTruthy(evaluate(node.operand, env));
    case "binary": {
      if (node.op === "&&") return isTruthy(evaluate(node.left, env)) && isTruthy(evaluate(node.right, env));
      if (node.op === "||") return isTruthy(evaluate(node.left, env)) || isTruthy(evaluate(node.right, env));
      return compare(node.op, evaluate(node.left, env), evaluate(node.right, env));
    }
  }
}

/** Parses and evaluates `source` against `env`. Throws ExpressionError on any parse or eval failure. */
export function evaluateExpression(source: string, env: Env): ExprValue {
  return evaluate(parseExpression(source), env);
}

/** Walks an expression's parse tree, calling `visit` on every `member`/`ident` chain rooted at a top-level identifier. */
export function walkReferences(source: string, visit: (path: string[]) => void): void {
  const node = parseExpression(source);
  const walk = (n: Node): void => {
    switch (n.kind) {
      case "ident":
        visit([n.name]);
        return;
      case "member": {
        const base = memberChain(n.target);
        if (base) visit([...base, n.name]);
        else walk(n.target);
        return;
      }
      case "index":
        walk(n.target);
        walk(n.index);
        return;
      case "call":
        for (const a of n.args) walk(a);
        return;
      case "unary":
        walk(n.operand);
        return;
      case "binary":
        walk(n.left);
        walk(n.right);
        return;
      default:
        return;
    }
  };
  walk(node);
}

function memberChain(n: Node): string[] | undefined {
  if (n.kind === "ident") return [n.name];
  if (n.kind === "member") {
    const base = memberChain(n.target);
    return base ? [...base, n.name] : undefined;
  }
  return undefined;
}

// --- prompt template rendering (§7.9, §9.9) ----------------------------------------------------

const PLACEHOLDER = /««([\s\S]*?)»»/g;

/**
 * Renders a prompt template against `env`, which MUST be `{ prompt_vars: {...} }` (§9.9). Throws
 * ExpressionError on any placeholder's parse/eval failure.
 */
export function renderTemplate(template: string, env: Env): string {
  // A lone «« with no following »» is a parse failure (§7.9), not literal text.
  let scanFrom = 0;
  for (;;) {
    const openIdx = template.indexOf("««", scanFrom);
    if (openIdx === -1) break;
    const closeIdx = template.indexOf("»»", openIdx + 2);
    if (closeIdx === -1) throw new ExpressionError(`unterminated placeholder (no matching »») in template: ${template}`);
    scanFrom = closeIdx + 2;
  }
  return template.replace(PLACEHOLDER, (_match, expr: string) => {
    const value = evaluateExpression(expr.trim(), env);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}
