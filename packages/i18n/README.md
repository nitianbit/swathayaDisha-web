# @jansetu/i18n

UI words, the app language and every money/date format (docs/I18N_PLAN.md). The engine is i18next, with
react-i18next in `@jansetu/ui`; screens never import either. They use the typed `t` of a catalogue.

## Extracting a string

1. Add a key to the area's `en.ts` (for example `apps/workspace/src/i18n/pharmacy/en.ts`; `packages/ui/src/i18n/en.ts`
   for shared words). Move the English byte for byte. A comment above the key is the translator's note:

   ```ts
   /** Under the price, before paying. */
   'wallet.collect': 'Collect {amount} from the patient at your counter.',
   'stock.units': { one: '{count} unit', other: '{count} units' },
   ```

   If the area has no catalogue yet, add `i18n/<area>/en.ts` and an `index.ts` with
   `export const t = catalogue('<app>-<area>', en, import.meta.glob(['./*.json', '!./*.source.json']));`
   (copy `packages/ui/src/i18n/index.ts`).

2. Call it where the words were: `t('wallet.collect', { amount: formatPaise(x) })`, `t('stock.units', { count: n })`.
   A wrong key or a wrong `{placeholder}` name fails `npm run typecheck`. Call `t` at render or in the event
   handler, never at module load. For an element inside the words use `t.rich` with `<Parts of={...} />`; for keys
   built from server codes check `t.has(key)` first.

3. When a file holds no more English, delete its line from `packages/i18n/literals-allowlist.txt`
   (`npx vitest run packages/i18n` says which files are clean or still hold words). A string that is not UI text is
   marked `// i18n-ignore: <reason>`.

Translations are machine-made (IndicTrans2) into `<lang>.json` next to `en.ts`; builders do not write them. A language
is released in an app once 95% of that app's words are present (`RELEASED` in `src/languages.ts`).
