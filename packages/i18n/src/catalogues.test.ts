// @vitest-environment node
/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTranslation, type Problem } from './check.ts';
import type { Messages } from './index.ts';
import { LANGUAGES, RELEASED, type AppName } from './languages.ts';

/**
 * Every catalogue in the repo (docs/I18N_PLAN.md §5.4): no extra keys, the same placeholders, the language's plural
 * forms, no empty or stale translation, and each released language with at least 95% of its app's words present
 * (machine translations count; nobody checks them by hand, owner decision 2026-11-25). Missing words are reported, not
 * failed: they show in English and go in the next machine-translation run.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SOURCES = ['packages/ui/src', 'packages/api/src', 'apps/customer/src', 'apps/workspace/src'];
const APPS: readonly AppName[] = ['customer', 'workspace'];

function catalogueDirs(dir: string, inI18n = false): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory() || name === 'node_modules') continue;
    const here = inI18n || name === 'i18n';
    if (here && existsSync(join(path, 'en.ts'))) out.push(path);
    out.push(...catalogueDirs(path, here));
  }
  return out;
}

const readJson = (path: string): Record<string, unknown> => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {});

const dirs = SOURCES.flatMap((s) => catalogueDirs(join(ROOT, s)));
const translatedLanguages = LANGUAGES.map((l) => l.code).filter((c) => c !== 'en');

describe('catalogues', () => {
  it('finds the catalogues (the shared UI words at least)', () => {
    expect(dirs.map((d) => relative(ROOT, d))).toContain(join('packages', 'ui', 'src', 'i18n'));
  });

  it('have no extra, misshapen, empty, stale or wrongly placed words, and released languages are 95% present', async () => {
    const problems: string[] = [];
    const coverage = new Map<string, { total: number; translated: number }>();
    for (const dir of dirs) {
      const where = relative(ROOT, dir);
      const en = (await import(/* @vite-ignore */ join(dir, 'en.ts')) as { default: Messages }).default;
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        if (!/^[a-z]{2,3}(\.source)?\.json$/.test(f) || !translatedLanguages.includes(f.slice(0, f.indexOf('.')) as never)) {
          problems.push(`${where}/${f}: not a first-wave language file`);
        }
      }
      for (const lang of translatedLanguages) {
        const result = checkTranslation(en, lang, readJson(join(dir, `${lang}.json`)), readJson(join(dir, `${lang}.source.json`)));
        problems.push(...result.problems.map((p: Problem) => `${where} ${lang} ${p.key}: ${p.kind}`));
        for (const app of APPS) {
          if (where.startsWith('apps/') && !where.startsWith(`apps/${app}/`)) continue;
          const c = coverage.get(`${app}:${lang}`) ?? { total: 0, translated: 0 };
          c.total += result.total;
          c.translated += result.translated;
          coverage.set(`${app}:${lang}`, c);
        }
        if (result.missing.length && RELEASED.customer.concat(RELEASED.workspace).includes(lang)) {
          console.info(`[i18n] ${where} ${lang}: ${result.missing.length} words not translated yet`);
        }
      }
    }
    for (const app of APPS) {
      for (const lang of RELEASED[app].filter((l) => l !== 'en')) {
        const c = coverage.get(`${app}:${lang}`) ?? { total: 1, translated: 0 };
        if (c.translated < 0.95 * c.total) problems.push(`${app} ${lang}: released but only ${c.translated} of ${c.total} words present`);
      }
    }
    expect(problems).toEqual([]);
  });
});
