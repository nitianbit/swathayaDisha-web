// @vitest-environment node
/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * No English written into the code (docs/I18N_PLAN.md §4.1): visible words come from a catalogue. Files not extracted
 * yet are listed in `literals-allowlist.txt`; each round removes its files, and the list is empty after round 6j. A
 * string that is not UI text (a programming error, a log line) is marked `// i18n-ignore: <reason>` on its line or the line
 * before; a marker without a reason covers nothing.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SOURCES = ['packages/ui/src', 'packages/api/src', 'apps/customer/src', 'apps/workspace/src'];
const ALLOWLIST = join(ROOT, 'packages/i18n/literals-allowlist.txt');

/** JSX attributes that hold codes, ids, styles or links, never words. */
const TECHNICAL = new Set([
  'className', 'id', 'key', 'type', 'href', 'to', 'variant', 'tone', 'inputMode', 'autoComplete', 'autoCapitalize', 'name',
  'role', 'htmlFor', 'accept', 'pattern', 'rel', 'target', 'method', 'lang', 'dir', 'value', 'defaultValue', 'form',
  'enterKeyHint', 'spellCheck', 'capture', 'download', 'src', 'mode', 'kind', 'size', 'step', 'min', 'max', 'slot', 'scope',
  'aria-describedby', 'aria-labelledby', 'aria-controls', 'aria-live', 'aria-current', 'aria-haspopup', 'aria-expanded',
  'aria-invalid', 'aria-busy', 'aria-hidden', 'aria-pressed', 'aria-checked', 'aria-modal', 'aria-atomic', 'aria-relevant',
  // Component props that take a code: a status or state to show, an id prefix, a role, whether a reason is asked.
  'status', 'state', 'idPrefix', 'viewer', 'audience', 'reason',
]);

/** Object properties that hold words even when they are one word (`{ label: 'Home' }`). */
const TEXT_PROPERTIES = new Set(['label', 'title', 'message', 'hint', 'section', 'text', 'description', 'placeholder', 'confirmLabel', 'consequence']);

/** Words a person reads: a capitalised word followed by more text, or several words ending like a sentence. */
const looksLikeWords = (text: string) => {
  const s = text.trim();
  return /[a-z]/.test(s) && (/^[A-Z][a-z’']*([\s,.:;?!…]|$)/.test(s) && /\s|[.?!…:]$/.test(s) || /\s/.test(s) && /[.?!…:]$/.test(s));
};

interface Hit { line: number; text: string }

/** A catalogue's word function: `t`, `shared`, `tc`, `recordsT` …, or its `.rich`. */
const isWordCall = (n: ts.Node): n is ts.CallExpression => {
  if (!ts.isCallExpression(n)) return false;
  const c = ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'rich' ? n.expression.expression : n.expression;
  return ts.isIdentifier(c) && /^(t|shared|t[A-Z]\w*|\w+T)$/.test(c.text);
};
/** A code a word is given (`ABC_DEF`, `abc_def`, `abc-def`), not words. */
const looksLikeCode = (s: string) => /^[A-Z0-9_]+$/.test(s) || /^[a-z0-9]+([_-][a-z0-9]+)+$/.test(s);

/**
 * A string with letters that reaches the screen as it is: a JSX child (`{'off'}`), a branch of a choice inside one
 * (`{n === 1 ? 'slot' : 'slots'}`, `{x || 'none'}`), a word attribute's value (`aria-label={a ? 'Open' : 'Close'}`), or
 * a value given to a catalogue word (`t('k', { where: 'below' })`).
 */
function shownAsIs(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, sf: ts.SourceFile): boolean {
  if (!/[A-Za-z]{2,}/.test(node.text) || looksLikeCode(node.text)) return false;
  let child: ts.Node = node;
  let p = node.parent;
  const logical = (b: ts.BinaryExpression) => [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
    .includes(b.operatorToken.kind) && b.right === child;
  while (p && ((ts.isConditionalExpression(p) && p.condition !== child) || ts.isParenthesizedExpression(p) || (ts.isBinaryExpression(p) && logical(p)))) {
    child = p;
    p = p.parent;
  }
  if (ts.isJsxExpression(p)) {
    if (ts.isJsxAttribute(p.parent)) {
      const name = p.parent.name.getText(sf);
      return !TECHNICAL.has(name) && !name.startsWith('data-');
    }
    return true;
  }
  if (ts.isPropertyAssignment(p) && p.initializer === child && ts.isObjectLiteralExpression(p.parent)) {
    const call = p.parent.parent;
    return isWordCall(call) && call.arguments[1] === p.parent;
  }
  return false;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'i18n' && name !== 'node_modules') out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function literalsOf(file: string, text: string): Hit[] {
  const lines = text.split('\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: Hit[] = [];
  // `// i18n-ignore: <reason>` (or `{/* i18n-ignore: <reason> */}` in JSX) covers its own line when it trails code, or the
  // next line when it stands alone. A marker without a reason covers nothing.
  const marker = /(\/\/|\/\*) i18n-ignore: \S.{2,}/;
  const commentOnly = (l: string) => /^\s*(\/\/|\{?\/\*)/.test(l);
  const ignored = (line: number) => (marker.test(lines[line] ?? '') && !commentOnly(lines[line] ?? ''))
    || (marker.test(lines[line - 1] ?? '') && commentOnly(lines[line - 1] ?? ''));
  const add = (node: ts.Node, words: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if (!ignored(line)) hits.push({ line: line + 1, text: words.trim().slice(0, 60) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console') return;
    if (ts.isJsxText(node)) {
      if (/[A-Za-z]{2,}/.test(node.text)) add(node, node.text);
      return;
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      // A route or path (`back="/admin/partners"`) is not words.
      if (init && ts.isStringLiteral(init) && !TECHNICAL.has(name) && !name.startsWith('data-') && /[A-Za-z]{2,}/.test(init.text) && !/^[/#]/.test(init.text)) {
        add(init, init.text);
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const isKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
      const wordsProperty = ts.isPropertyAssignment(parent) && parent.initializer === node && TEXT_PROPERTIES.has(parent.name.getText(sf))
        && /[A-Za-z]{2,}/.test(node.text);
      if (!isKey && !ts.isElementAccessExpression(parent) && (wordsProperty || looksLikeWords(node.text) || shownAsIs(node, sf))) add(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const words = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' x ');
      if (looksLikeWords(words)) add(node, words);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
const literalsIn = (file: string) => literalsOf(file, readFileSync(file, 'utf8'));

const allowlist = () => readFileSync(ALLOWLIST, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

describe('no English written into the code', { timeout: 60_000 }, () => {
  const listed = new Set(allowlist());
  // Each file is parsed once for both checks below.
  let hits: Map<string, Hit[]>;
  beforeAll(() => {
    hits = new Map(SOURCES.flatMap((s) => sourceFiles(join(ROOT, s))).map((f) => [relative(ROOT, f), literalsIn(f)]));
  }, 60_000);

  it('finds words in JSX text, attributes, sentences and templates, and honours i18n-ignore', () => {
    const count = (code: string) => literalsOf('x.tsx', code).length;
    expect(count('const a = <p>Book a doctor</p>;')).toBe(1);
    expect(count('const a = <TextField label="Mobile number" />;')).toBe(1);
    expect(count('const a = <Button variant="ghost" className="j-btn" aria-describedby="x-hint" />;')).toBe(0);
    expect(count('const a = <NoSuchRecord back="/admin/partners" />;')).toBe(0);
    expect(count("const a = 'This time was just taken.';")).toBe(1);
    expect(count('const a = `Send code in ${n}s`;')).toBe(1);
    // A lone capitalised word is found in JSX; as a bare string it is too often a code.
    expect(count("const tabs = [{ to: '/', label: 'Home' }];")).toBe(1);
    expect(count("const a = 'Wallet'; const b = 'SLOT_NOT_AVAILABLE'; const c = 'j-btn j-btn--primary'; const d = '/api/v1';")).toBe(0);
    expect(count("import x from 'Some module path';\ntype T = 'Not a word.';\nconsole.warn('Logged, not shown.');")).toBe(0);
    expect(count("// i18n-ignore: a programming error\nthrow new Error('Invalid API path.');")).toBe(0);
    // A marker needs a reason, and covers only the next line (or its own, after code).
    expect(count("// i18n-ignore\nthrow new Error('Invalid API path.');")).toBe(1);
    expect(count("// i18n-ignore: a programming error\nconst a = 1;\nthrow new Error('Invalid API path.');")).toBe(1);
    expect(count("throw new Error('Invalid API path.'); // i18n-ignore: a programming error")).toBe(0);
    // Words shown as they are: a JSX child, a branch of a choice inside one, a word attribute, a value given to a word.
    expect(count("const a = <p>{n === 1 ? 'slot' : 'slots'}</p>;")).toBe(2);
    expect(count("const a = <p>{name || 'nobody'}</p>;")).toBe(1);
    expect(count("const a = <Button aria-label={open ? 'Close it' : 'Open'} />;")).toBe(2);
    expect(count("const a = t('k', { where: 'below' });")).toBe(1);
    expect(count("const a = <div className={open ? 'is-open' : 'shut'} />; const b = t('k', { code: 'SLOT_FULL' });")).toBe(0);
  });

  it('every file outside the allowlist has no English written into it', () => {
    const found = [...hits].filter(([file, h]) => !listed.has(file) && h.length)
      .map(([file, h]) => `${file}: ${h.length}, first line ${h[0]!.line} "${h[0]!.text}"`);
    expect(found).toEqual([]);
  });

  it('the allowlist names only existing files that still hold English (remove a file once it is extracted)', () => {
    const stale = [...listed].filter((f) => !existsSync(join(ROOT, f)) || !hits.get(f)?.length);
    expect(stale).toEqual([]);
  });
});
