// @vitest-environment node
/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * No English written into the code (docs/I18N_PLAN.md §4.1): visible words come from a catalogue. Files not extracted
 * yet are listed in `literals-allowlist.txt`; each round removes its files, and the list is empty after round 6j. A
 * string that is not UI text (a programming error, a log line) is marked `// i18n-ignore` on its line or the line before.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SOURCES = ['packages/ui/src', 'packages/api/src', 'apps/customer/src', 'apps/workspace/src'];
const ALLOWLIST = join(ROOT, 'packages/i18n/literals-allowlist.txt');

/** JSX attributes that hold codes, ids, styles or links, never words. */
const TECHNICAL = new Set([
  'className', 'id', 'key', 'type', 'href', 'to', 'variant', 'tone', 'inputMode', 'autoComplete', 'autoCapitalize', 'name',
  'role', 'htmlFor', 'accept', 'pattern', 'rel', 'target', 'method', 'lang', 'dir', 'value', 'defaultValue', 'form',
  'enterKeyHint', 'spellCheck', 'capture', 'download', 'src', 'mode', 'kind', 'size', 'step', 'min', 'max', 'slot',
  'aria-describedby', 'aria-labelledby', 'aria-controls', 'aria-live', 'aria-current', 'aria-haspopup', 'aria-expanded',
  'aria-invalid', 'aria-busy', 'aria-hidden', 'aria-pressed', 'aria-checked', 'aria-modal', 'aria-atomic', 'aria-relevant',
]);

/** Object properties that hold words even when they are one word (`{ label: 'Home' }`). */
const TEXT_PROPERTIES = new Set(['label', 'title', 'message', 'hint', 'section', 'text', 'description', 'placeholder', 'confirmLabel', 'consequence']);

/** Words a person reads: a capitalised word followed by more text, or several words ending like a sentence. */
const looksLikeWords = (text: string) => {
  const s = text.trim();
  return /[a-z]/.test(s) && (/^[A-Z][a-z’']*([\s,.:;?!…]|$)/.test(s) && /\s|[.?!…:]$/.test(s) || /\s/.test(s) && /[.?!…:]$/.test(s));
};

interface Hit { line: number; text: string }

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
  const ignored = (line: number) => /i18n-ignore/.test(lines[line] ?? '') || /i18n-ignore/.test(lines[line - 1] ?? '');
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
      if (init && ts.isStringLiteral(init) && !TECHNICAL.has(name) && !name.startsWith('data-') && /[A-Za-z]{2,}/.test(init.text)) {
        add(init, init.text);
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const isKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
      const wordsProperty = ts.isPropertyAssignment(parent) && parent.initializer === node && TEXT_PROPERTIES.has(parent.name.getText(sf))
        && /[A-Za-z]{2,}/.test(node.text);
      if (!isKey && !ts.isElementAccessExpression(parent) && (wordsProperty || looksLikeWords(node.text))) add(node, node.text);
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
    expect(count("const a = 'This time was just taken.';")).toBe(1);
    expect(count('const a = `Send code in ${n}s`;')).toBe(1);
    // A lone capitalised word is found in JSX; as a bare string it is too often a code.
    expect(count("const tabs = [{ to: '/', label: 'Home' }];")).toBe(1);
    expect(count("const a = 'Wallet'; const b = 'SLOT_NOT_AVAILABLE'; const c = 'j-btn j-btn--primary'; const d = '/api/v1';")).toBe(0);
    expect(count("import x from 'Some module path';\ntype T = 'Not a word.';\nconsole.warn('Logged, not shown.');")).toBe(0);
    expect(count("// i18n-ignore: a programming error\nthrow new Error('Invalid API path.');")).toBe(0);
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
