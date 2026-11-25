# Phase 6 build specification: whole-app UI translation (i18n)

Designed in WQ30 (2026-11-25, base web `stage` at `f089b46`); round 6a built in WQ31; the engine moved to i18next +
react-i18next in WQ40 (owner decisions of 2026-11-25, §1 items 7–9). Backend references:
`../SwasthaDisha/documentation/planning/implementation/ASSISTED_BOOKING_DESIGN.md` §5.2 (language fields), §11 (languages
and UI translation) and §27 (phase 5 SMS, branch `m0/r23-phase5-spec`). Where this document and §11.2 differ for the web
apps, this one wins (§3.1 says why).

## 1. Owner decisions this builds (not reopened)

1. Customers **and** partners can switch their app to any available language. This is the whole UI, not only SMS.
2. First wave: Hindi `hi`, English `en`, Assamese `as`, Bengali `bn`, Odia `or`. Mizo and other north-east languages come
   later.
3. The patient's language is asked at booking and is already stored (`assisted.preferredLanguage`;
   `User.preferredLanguage`, filled by a booking when empty: backend `assisted/patient.ts:121`).
4. Keep the UI easy and minimal. No duplicated code. No drop in code quality.
5. No token, OTP or patient data in storage, URLs or logs. A language preference is not patient data.
6. ~~Native speakers check the translations.~~ Replaced on 2026-11-25 by items 8 and 9.
7. **Engine (2026-11-25):** the open-source `i18next` + `react-i18next`, not an in-house engine (§3.1).
8. **Translations (2026-11-25):** machine only, made with IndicTrans2, kept as static JSON files in the repo. No human
   checker.
9. **Release gate (2026-11-25):** a language is released in an app once at least 95% of that app's words are
   **present** (machine translations count). The old "95% checked" rule is dropped.

## 2. The code today

| Fact | Where | Consequence |
|---|---|---|
| No i18n library; `<html lang="en">` | `package.json`; `apps/*/index.html` | Free to choose (§3.1) |
| Most text is inline JSX or string literals | every screen | Extracted round by round (§4) |
| `packages/api` holds the shared words: 52 exported `*_LABEL` / `*_WORDS` / `*_MESSAGE` constants, word helpers (`joinWords`, `cancelWords`, `movementLabel`, `rescheduleRuleText` …) and about 170 error-code → sentence entries (`CODE_WORDS`, `LIMIT_WORDS`, `RESCHEDULE_WORDS` in `assisted.ts:522-612`, `labRefusal`, `moveRefundRefusal`, `doctorStateRefusal` …) | `packages/api/src/*.ts` | The api package needs translated words but must not depend on React or `@jansetu/ui`: the core goes in a new framework-free package (§3.2) |
| Two copies of `messageOf`: known codes, else the server's `message` "as given" (≈305 call sites) | `apps/customer/src/common.tsx:15`; `apps/workspace/src/errors.ts:4` | Merged into one, code-first (§6) |
| Text built from fragments: `cancelWords(…, told = 'The patient and the doctor are told.')`, about 40 `n === 1 ? '' : 's'` plurals, `withNote` (copied in both `session.tsx`) | `assistedCard.ts:244`; both `session.tsx` | Whole sentences and real plurals (§3.4) |
| Text fixed at load or kept in state: nav labels and sections in `modules.tsx`, the customer `TABS`, `roleLabel` saved at sign-in (`session.tsx:376`), session notices composed in English and compared by equality (workspace `session.tsx:242`, `:249`) | workspace and customer | Keys and codes, turned into words at render (§3.4) |
| Formatting: `formatRupees`, `formatDateTime` (`packages/ui/src/index.tsx:110`, `:115`) plus 13 more `Intl` calls fixed to `en-IN`/`en-GB`, two copies of `rupees(paise)` (`assisted.ts:507`, `assistedCard.ts:223`) and of the YYYYMMDD date (`assisted.ts:362`, `inventory.ts:139`); `formatYmd`, `formatDay`, `formatDate`, `formatAppointment`, three 24-hour clocks | api, ui, both apps | One `format` module (§3.5) |
| Fonts: `system-ui … 'Noto Sans', 'Noto Sans Devanagari'`; nothing for Bengali or Odia; CSP `font-src 'self'` (no font CDN) | `tokens.css:30`; both `vite.config.ts` | Self-hosted fonts (§3.8) |
| `.ws-nav-section` uses `text-transform: uppercase` and `letter-spacing` (spacing breaks Indic letter joining); `.j-badge` does not wrap | `apps/workspace/src/styles.css:21`; `tokens.css:96-105` | CSS fixes in 6a |
| Consent: one English sentence, `statementVersion: 'web-pharmacy-v2'`, `statementLanguage: 'en'` sent with each booking | `assisted.ts:54-57`; `patientStep.tsx:206` | A text per language (§4, round 6f; Q2) |
| `PATIENT_LANGUAGES`: 19 codes with English names, for "Language the patient speaks" | `assisted.ts:41` | Names become catalogue words |
| Backend: no `uiLanguage` yet (§5.2 planned it). Both apps read `GET /auth/profile` at sign-in, which returns the account document | backend `auth/controller/index.ts:189`; customer `session.tsx:258`, workspace `session.tsx:343` | One small backend round (6a-backend, §3.7) |
| Tests: Vitest 422 (several assert English words from `packages/api`). Playwright workspace 448 tests and customer 132, each on 2 devices, with about 5,700 and 960 English text locators. Neither Playwright config sets `locale`, so the browser takes the machine's | `apps/*/e2e`, `apps/*/playwright.config.ts` | English stays the default and must stay byte-identical (§4.2) |
| No CI config in the repo; the checks are the list in `AGENTS.md` | — | The i18n checks run inside `npx vitest run` |
| `Intl` (Node 24, full ICU): `bn-IN` and `as-IN` print Bengali digits; `or-IN` groups money in thousands (`₹123,456.50`); `as-IN` puts a space after ₹; all five first-wave languages have just two plural forms (`one`, `other`) | checked 2026-11-25 | Money stays `en-IN`; dates use the language with Latin digits (§3.5) |

**Size (rough grep, some noise; likely 10–20% fewer):**

| Part | Strings | Words |
|---|---|---|
| `packages/ui` | ~8 | ~50 |
| `packages/api` (labels, refusals, error codes) | ~610 | ~5,400 |
| `apps/customer` | ~530 | ~3,100 |
| Workspace shell, sign-in, home, shared components | ~155 | ~1,200 |
| Workspace pharmacy: operations / assisted booking and wallet | ~490 / ~490 | ~3,100 / ~3,500 |
| Workspace lab (slots, lab bookings, catalogue) / partner bills | ~345 / ~225 | ~1,900 / ~1,250 |
| Workspace clinic (desk, clinic doctors) / partner team (staff, branches, profile, audit) | ~215 / ~270 | ~1,250 / ~1,250 |
| Workspace doctor / admin / finance | ~355 / ~570 / ~210 | ~2,200 / ~3,700 / ~1,200 |
| **Total (distinct)** | **~4,000** | **~28,000** |

## 3. Approach

### 3.1 Library: i18next + react-i18next behind a typed `t` (owner decision 2026-11-25)

WQ30 planned no library and WQ31 built a small in-house engine. The owner chose the open-source `i18next` +
`react-i18next` instead (§1 item 7); WQ40 moved the engine and kept everything screens touch:

- **One i18next instance** (`packages/i18n/src/store.ts`, exported as `i18n`). Each catalogue is one namespace of flat
  keys (`keySeparator` and `nsSeparator` off, so `wallet.title` is one key). Placeholders are `{name}` (i18next's
  prefix and suffix set to `{` and `}`), inserted as written: no HTML escaping (React escapes), no nesting, no second
  pass. Plurals are stored as `key_one` / `key_other` (i18next's suffixes, picked by `Intl.PluralRules`). Fallback is
  English. i18next fetches nothing: `catalogue()` adds the English words, `setLanguage()` adds a language's JSON
  (still one lazy chunk per catalogue and language) before switching.
- **The typed `t(key, params)` stays the only call screens make.** Keys and `{placeholder}` names are still typed from
  `en.ts` (a wrong one fails `npm run typecheck`), which i18next's own types would only give from JSON. So extraction
  rounds running in parallel do not change when the engine does.
- **React:** `@jansetu/ui` registers the instance with react-i18next (`setI18n`, so no provider is needed) and
  `useLanguage()` is react-i18next's `useTranslation()`; `LanguageScope` and `LanguageSwitcher` are unchanged.
- **Unchanged:** the catalogue files and layout, `jansetu.lang`, the format module, the pseudo-language (now generated
  as an i18next language in development only), the catalogue check and the literal scan.
- **Dependencies:** `i18next` (in `@jansetu/i18n`, which stays React-free so `@jansetu/api` can use it) and
  `react-i18next` (in `@jansetu/ui`). No i18next plugins, parser or translation server.

### 3.2 Layout

```
packages/i18n/                    workspace package (@jansetu/i18n): i18next only, no React
  src/index.ts                    catalogue(), the typed t, loading (fallback, plurals, placeholders: i18next)
  src/store.ts                    the i18next instance and the current language
  src/format.ts                   money, numbers, dates and times (§3.5)
  src/languages.ts                code, own name, script, released per app (§3.7)
  src/digits.ts                   Indian-script digits → 0-9 (§3.5)
  src/pseudo.ts                   pseudo-language for development and tests only
  src/catalogues.test.ts          the catalogue check (§5.4)
  src/literals.test.ts            the no-literal scan + its shrinking allowlist (§4.1)
  scripts/i18n.mjs                export / import / prune of translator files (§5)
packages/ui/src/i18n/             shared words (Loading…, Try again, Back …): `shared` from @jansetu/ui, keys listed atop en.ts
packages/api/src/i18n/            core: errors.<CODE> words of `messageOf`, sign-in and session words
packages/api/src/i18n/<area>/     statuses, refusals, error-code words per area (assisted, pharmacy, customer, doctor,
                                  partner, lab, admin, finance); words.ts: wordMap / labelledList / valueList / onLanguage
apps/customer/src/i18n/           the customer app
apps/workspace/src/i18n/<area>/   shell, pharmacy, lab, clinic, partner, doctor, admin, finance
```

Each catalogue folder holds `en.ts` (the English source, TypeScript), `hi.json`, `as.json`, `bn.json`, `or.json` (machine
translations, §5) and `<lang>.source.json` (the English each translation was made from; read by the check and the
scripts, never shipped). One catalogue per workspace area keeps rounds and translator batches apart and avoids merge
conflicts. `@jansetu/ui` re-exports what screens need (`formatRupees`, `formatDateTime`, `useLanguage`,
`LanguageScope`, `LanguageSwitcher`), so existing imports keep working.

### 3.3 Entries and `t`

```ts
// apps/workspace/src/i18n/pharmacy/en.ts: the English source. A comment above a key is the translator's note.
export default {
  'wallet.title': 'Wallet',
  /** Under the price, before paying. */
  'wallet.collect': 'Collect {amount} from the patient at your counter.',
  'stock.units': { one: '{count} unit', other: '{count} units' },
};

// apps/workspace/src/i18n/pharmacy/index.ts
import en from './en.ts';
export const t = catalogue('workspace-pharmacy', en, import.meta.glob('./*.json'));

// In a screen
t('wallet.title');
t('stock.units', { count: 3 });                                   // Intl.PluralRules picks the form
t.rich('wallet.collect', { amount: <strong>{formatRupees(x)}</strong> }); // text and elements, for React
t('wallet.collect', { amont: '₹5' });                             // type error: no such placeholder
t.has(`errors.${code}`);                                          // for codes from the server (§6)
```

- **Keys** are typed from `en.ts`; placeholders are typed from the `{name}` parts of the English text.
- **Plurals:** an entry `{ one, other }` with `count`. A later language with more forms adds them in its JSON; the check
  accepts exactly the forms `Intl.PluralRules` names for it.
- **Placeholders:** values are inserted as written (a number is not regrouped), so English stays exactly as the old
  `${n}` wrote it; pass formatted text (`formatRupees`, a date) where the format matters.
- **Fallback:** translation, else English. A key never shows. In development, a missing translation is noted
  once in the console by **key only** (params may hold a patient's name: never printed).
- **Loading:** English is bundled. Other languages load on choice (`import.meta.glob`: one hashed chunk per catalogue and
  language, cached; inside the phone apps the chunks are local files, so it works offline).

### 3.4 Rules for code (every round)

1. **No words at module load.** Module-level maps hold keys (`BOOKING_STATUS_LABEL = { pending: 'booking.status.pending',
   … }`); `t` runs at render or in the event handler. WQ42 kept the exported shapes of `packages/api` (so the screens
   needed no change): `wordMap` and the list helpers read the words at each lookup, and an exported string constant is
   an `export let` set again on every language change (`onLanguage`, an ES live binding).
2. **No words in long-lived state.** Session notices become codes (`'expired' | 'signed_out_here' | …`, one `noticeWords`
   for both apps instead of two `withNote`); `roleLabel` is computed at render.
3. **Whole sentences.** Joining whole sentences is fine; building a sentence from fragments is not. Default parameters
   holding English words become keys.
4. **Move, don't rewrite.** English text moves byte-for-byte. A wording change is a separate, named change.
5. **Data is never translated:** names, reasons and notes people typed, medicine, test and catalogue names, doctor
   specialities, addresses, and the masked holder name.
6. **Keys** are `screen.purpose` inside the area's catalogue (`book.patient.title`). A changed meaning gets a new key; a
   typo fix keeps it (`npm run i18n -- accept <key>`, §5.4).

### 3.5 Money, numbers, dates and digits

`packages/i18n/src/format.ts` replaces the 15 `Intl` call sites and the duplicated helpers: `money(rupees)`,
`moneyMinor(paise)`, `number(n)`, `dateTime(iso)`, `date(iso)`, `day(iso)` (with weekday), `ymd(yyyymmdd)` (the slot's own
date) and `time(...)` (24-hour), all in India time as today.
- **Money and plain numbers use `en-IN` in every language:** Indian grouping and `₹1,23,456.50` everywhere (`or-IN`
  would group in thousands; `as-IN` adds a space).
- **Dates and times use `<lang>-IN-u-nu-latn`:** month and weekday names in the language, digits 0-9 (as the SMS in
  §27.5.5). Example `hi`: `25 नव॰ 2026, 2:35 pm`.
- **English output stays byte-identical** to today's helpers (the e2e suites assert it).
- **Typed digits:** many Indian keyboards type `०-९`, `০-৯` or `୦-୯`. `TextField` turns them into 0-9 when
  `inputMode` is `numeric`, `decimal` or `tel`, so phone numbers, codes, amounts and quantities validate as today.

### 3.6 Fallback

Per string: translation → English. An app lists a language only once it is **released** for that app (§3.7),
so at most a few new strings show in English while their translation is on its way.

### 3.7 The switcher and where the choice is stored

**UI (one native `<select>`, no flags, no first-run wizard):**
- Each language is written in its own script and never translated: English, हिन्दी, অসমীয়া, বাংলা, ଓଡ଼ିଆ. Each `<option>`
  carries its `lang`.
- The label is "Language" in the current language, plus "Language" in English when they differ (`भाषा · Language`), so
  a person who lands in a language they cannot read still finds it.
- Placed on both **sign-in screens** (under "Jansetu", above the form), in the customer **Profile** (first card) and in
  the workspace **side bar** above "Sign out".

**Stored:**
- **Signed in:** the account's `uiLanguage` on the server. A pharmacy login is shared by its staff, so its language is
  shared too.
- **Before sign-in:** `localStorage['jansetu.lang']`, the code only, for the sign-in screen. Written whenever a language
  is applied, so after sign-out the screen keeps the last language. Never in a URL, never logged.

**Which language applies:**
- **Before sign-in:** the stored code if released → the first browser language (`navigator.languages`) that is released
  → English.
- **At sign-in:**
  1. a language picked on the sign-in screen during this visit (saved to the account);
  2. else the account's `uiLanguage`;
  3. else, for customers, the language asked at booking (`preferredLanguage`), applied but not saved;
  4. else the language already showing.
- Codes the app has not released are ignored at every step.

**Applying a language:**
1. Load that language's JSON for every catalogue.
2. Set `<html lang>`.
3. Write `localStorage`.
4. `LanguageScope` remounts the page content, as if the person left the page and came back; the shell and tab bar
   re-render. The session, the query cache and a doctor's "available now" (`presence.tsx`) stay mounted. Unsaved typing
   on the current page is lost, as when leaving a page.

Signed in, the choice is then sent with `PUT /auth/profile/ui-language`. If it fails, the language still applies here
and one line under the switcher says "Saved on this device only." There is no retry loop. If a language cannot load
(offline web), nothing changes and the switcher says so.

**6a-backend (SwasthaDisha, its own review):**
- `uiLanguage?: string` on every account that signs in to the web: `User` (customers), `Admin`, `Specialist`,
  `Pharmacy`, `PartnerMember`.
- `GET /auth/profile` returns it. The pharmacy and partner answers are built views (`withoutCreateKey`,
  `partnerOwnView`), so the field is added there too.
- `PUT /api/v1/auth/profile/ui-language { uiLanguage }` changes only the caller's own account (by `userType`). It accepts
  `^[a-z]{2,3}$`, as `preferredLanguage` does, and answers `{ uiLanguage }`. It is idempotent, needs no audit and logs
  no value. (§11.2 named it `PUT /me/ui-language`; it sits next to the profile read the apps already make.)

### 3.8 Fonts

- **Fonts:** Noto Sans Devanagari, Noto Sans Bengali (it also covers Assamese, including ৰ and ৱ) and Noto Sans Oriya,
  as variable WOFF2 files in `packages/ui/src/fonts/` with `OFL.txt` (SIL Open Font License).
- **Downloads:** each `@font-face` lists `local()` first, so a phone that has the font downloads nothing. Its
  `unicode-range` covers only that script's own Unicode block, so an English page downloads nothing and a Hindi reader
  never downloads Odia.
- **Loading:** `font-display: swap`. The CSP is unchanged (`font-src 'self'`).
- **CSS:** for `:lang(hi|as|bn|or)`, headings get `line-height: 1.4` (tall vowel signs), and `.ws-nav-section` drops
  uppercase and letter spacing. Badges may wrap.
- **No right-to-left:** none of the planned languages needs it (`dir="ltr"` stays).

### 3.9 Pseudo-language (development and tests only)

`pseudo` turns English into bracketed, accented and 35% longer text (`⟦Ŵåļļéţ ~~~⟧`). Any plain English left on a screen
is a missed literal; any clipped text is a layout that will break in Hindi or Bengali. It is never offered in a release
build.

## 4. Extraction plan

Each round is one build and one independent review (Opus xhigh). Commits stay local; stage only on the owner's word.

| Round | Content | Strings |
|---|---|---|
| **6a** (built, WQ31; engine moved to i18next + react-i18next in WQ40) | `packages/i18n` (core, format, pseudo, catalogue check, literal scan with its starting allowlist); `LanguageSwitcher` (shows nothing until a second language is released), `LanguageScope` and the start-up rules of §3.7 in both apps; Playwright `locale`; a start-up smoke spec per app. Moves the 15 `Intl` call sites to `format` | 2 |
| **6a2** | Before the first hand-off (after 6c): the translator script (CSV export, import, prune, accept); before the first release: fonts and the Indic CSS (§3.8), typed Indian-script digits (§3.5), and the switcher's save to the account once 6a-backend exists | ~2 |
| **6a-backend** | `uiLanguage` and `PUT /auth/profile/ui-language` (§3.7), with an integration test | — |
| **6b** | Shared words: `packages/ui`, then every word in `packages/api` (labels, refusals, word helpers, plurals). One `messageOf` in `@jansetu/api` (§6) | ~620 |
| **6c** | Customer app: all screens, `TABS`, `BOOKING_STATUS`, `common.tsx`, `labels.ts`, session notices as codes | ~530 |
| **6d** | Workspace shell: `modules.tsx` nav labels and sections, `Shell`, sign-in, home, `roleLabel`, session notices; shared components (`ConfirmAction`, `PendingOpPanel`, `NoShowMove`, `CancelRequestPanel`); finance screens (used by partners, doctors and admin) | ~365 |
| **6e** | Pharmacy operations: orders, prescription review, stock, low stock, quality, suppliers, add and import stock, settings | ~490 |
| **6f** | Pharmacy assisted booking and wallet: book consultation, book lab test, booked lists and pages, booking changes, wallet, top-up, card payment. The consent text per language (Q2); patient-language names | ~490 |
| **6g** | Lab: slots, lab bookings, catalogue; partner bills (invoice screens) | ~570 |
| **6h** | Clinic: front desk, clinic doctors; partner team: staff, branches, profile, audit | ~485 |
| **6i** | Doctor: appointments, schedule, Consult now, clinics, earnings, presence | ~355 |
| **6j** | Admin: every admin screen (Q4) | ~570 |
| **6k** | Release, per app and per language, once its machine translations are 95% present: import, add it to `RELEASED`, smoke spec, 360 px check | — |

**Order:**
- 6a and 6a-backend can run side by side; then 6b → 6c. The customer batch (6b + 6c) goes to machine translation right
  away, so the customer app can be released first.
- 6d next. Then 6e–6j: each changes only its own area catalogue and the api module files of its area. They can run
  side by side if the shared api catalogue is merged with care; one after another is simpler.

### 4.1 Done means (every extraction round)

1. **No literals left.** Every visible text in the round's files comes from a catalogue: JSX text, `label`, `title`,
   `hint`, `placeholder`, `aria-label`, `alt`, `message`, `consequence` and the like, and sentence-like literals. The
   round's files leave the allowlist of `literals.test.ts` (it parses with TypeScript, already a dev dependency). It is
   empty after 6j. A real non-UI string is marked `// i18n-ignore` with a reason.
2. **Codes mapped.** The error codes the round's screens can meet (read from the backend routes they call) are mapped
   to words (§6). The English words are the backend's current `message`, so English assertions hold.
3. **English unchanged.** Typecheck, Vitest and both Playwright suites pass with assertions unchanged. Any changed
   assertion is named in the commit with its reason.
4. **Pseudo pass.** The round's screens are walked in `pseudo` at 360 px (customer) or tablet width (workspace): no
   plain English, no clipped or overlapping text.
5. **Hand-off.** The new keys go in the next machine-translation run (§5.3).

### 4.2 How the tests keep passing

- **English by default.** Both Playwright configs set `use.locale: 'en-IN'`, so the first-guess rule (§3.7) always gives
  English on any machine. No test chooses a language, so no test sends the new `PUT`. Profile mocks without
  `uiLanguage` change nothing.
- **Vitest.** English is bundled, so unit tests need no awaits. `tests/setup.ts` resets the language after each test.
  The existing English assertions in `packages/api` tests stay as they are.
- **New unit tests (6a):**
  - placeholders and plurals in all five languages; fallback; `has`;
  - `format`: English output equal to today's helpers, Latin digits for `bn` and `as`, money identical in every
    language;
  - typed-digit conversion.
- **One smoke spec per app, `e2e/i18n.spec.ts`,** run for `pseudo` from 6a and for each language once released (6k).
  Expected words are read from the catalogue JSON, never written into the spec. It checks:
  - switching on the sign-in screen sets `<html lang>` and translates the sign-in title;
  - signing in (mocked) sends `PUT /auth/profile/ui-language` with the code;
  - home and one deep screen per area show translated headings, with no key-like text;
  - money shows `₹` with Latin digits and a date shows the language's month name;
  - the script's font is in use (`document.fonts.check`);
  - nothing is wider than a 360 px phone;
  - a reload keeps the account's language, and sign-out keeps it on the sign-in screen.

## 5. Translation workflow

### 5.1 Who (owner decision 2026-11-25)

- **Machine only:** every translation is made with IndicTrans2 (`hi`, `as`, `bn`, `or`) and committed as static JSON
  next to the catalogue's `en.ts`. There is no human checker and no second check.
- **SMS:** the phase 5 SMS texts (§27.11 Q5) are made the same way, so the words match.

### 5.2 Glossary

About 80 terms are fixed per language before the first bulk run, so every screen uses the same words, and applied to
the machine output (examples: wallet, top-up, refund, prescription, consultation, lab test, sample collection,
booking, slot, coupon, UPI, OTP; "Jansetu" stays in Latin letters). The run keeps `{placeholders}` exactly and writes
no digits as words; the catalogue check refuses a text whose placeholders differ.

### 5.3 The files

The translator script (round 6a2) exports the missing and stale English per language, runs it through IndicTrans2 and
imports the result into `<lang>.json`, writing the English each text was made from into `<lang>.source.json`. Plurals
are one entry per form (`stock.units#one`, `stock.units#other`). Import refuses a text whose placeholders differ, that
is empty, or whose key no longer exists. Nothing is marked "checked".

### 5.4 Keeping keys in sync (the check)

`catalogues.test.ts` runs in `npx vitest run` (every round's checks, and any CI added later). It **fails** on:
- a key in a translation that is not in English: delete it with `npm run i18n -- prune`;
- different placeholders, or wrong plural forms;
- an empty string;
- a **stale** translation, whose `source.json` English differs from today's English: give the key a new name if the
  meaning changed, or run `npm run i18n -- accept <key>` if it did not;
- a **released** language with less than **95%** of its app's strings **present** (machine translations count; owner
  decision 2026-11-25, replacing "95% checked").

It **reports** (does not fail) the missing strings per language and app. These go in the next machine-translation run.

A feature adds about 1–3% new strings, so one feature never trips the 95% gate. The gate trips only when translation
falls behind, which is when work should pause for it. Missing keys in code cannot happen: they are type errors.

### 5.5 Later languages

- **Add:** a code in `languages.ts` with `released: false`, then the same workflow.
- **Latin scripts:** Mizo, Khasi and Garo need no font.
- **Devanagari:** Nepali and Bodo use the Devanagari font.
- **Manipuri:** needs Meetei Mayek fonts only if O4 picks that script.

## 6. Server-side text that reaches people

**Recommendation: words come from codes on the web.** The server's `message` stays English: developer text and the last
fallback. The server translates only text that leaves the web apps (SMS, PDF, push, email), from per-language template
files keyed by a stored language (the booking's `preferredLanguage` or the account's `uiLanguage`), never by
`Accept-Language`.

| Text | Today | Phase 6 |
|---|---|---|
| Error `message` (about 495 codes on the stage line) | Web maps about 170; the rest are shown "as given" | Web: one `messageOf` in `@jansetu/api`. Context words first (booking, reschedule, lab …), then shared `errors.<CODE>`, then the server's English message, then "Something went wrong". Each round maps its screens' codes (§4.1). Backend rule: every refusal a person can meet has a stable `code`, and values travel in fields (`details`, `retryAfter`, `limit`), never only inside the text |
| `VALIDATION_ERROR` text | Shown as given | The web already checks with the backend's rules first; the server text is only the fallback |
| Statuses, kinds, movements, audit actions | Web label maps | Keys (6b and the area rounds) |
| Stored English descriptions (e.g. customer wallet `description`) | Shown | Label from the row's codes (`transactionType`, `referenceType`); `description` only as a fallback |
| PDFs: bills (`invoicePdf.ts`), prescription dispensing copy | English | English in phase 6 (Q3) |
| SMS notices and the `/j/` page | Phase 5 templates per language (§27.5.5; `/j/` in English and Hindi, SM16) | Phase 5 owns them. The `as`, `bn` and `or` texts are machine-made like the UI (§5.1) |
| Sign-in code SMS and emails | English | English in phase 6 |
| Push and in-app notifications (server-built reminders) | Not on the web yet | When built: stored as `{ type, params }` and worded by the app; push text from a server template file per language, by `uiLanguage` |

## 7. ASSUMED (reversible)

Until the owner answers §8, the recommended answers are built.

1. ~~No i18next.~~ **Decided 2026-11-25:** i18next + react-i18next behind the same typed `t(key, params)` (§3.1). No
   parser plugin and no Tolgee/Weblate.
2. **Files.** English source in TypeScript; translations in JSON, made by IndicTrans2. No translation server.
3. **Release gate (decided 2026-11-25).** A language shows in an app's switcher once ≥95% of that app's strings are
   present (machine translations count; no checking). Missing strings show English. The check fails when a released
   language falls below 95%.
4. **Which language applies:** §3.7. The sign-in screen's choice this visit wins and is saved. Then the account's
   `uiLanguage`. Then, for customers, the booking language (applied, not saved). Then the device's last language,
   then the browser language, then English.
5. **Stored.**
   - Account `uiLanguage`; a pharmacy's shared login shares one language.
   - `localStorage['jansetu.lang']`: the code only.
   - Never in URLs or logs.
6. **Switching remounts the page.** Unsaved typing on that page is lost, as when leaving it. Session, cache and doctor
   presence are kept.
7. **Digits and formats.**
   - Latin digits 0-9 in every language, as in the SMS.
   - Digits typed in Indian scripts become 0-9 in numeric fields.
   - Money uses `en-IN` in every language; dates use the language's month and weekday names, in India time.
8. **Fonts.** Self-hosted Noto Sans Devanagari, Bengali and Oriya, `local()` first, script-only `unicode-range`. CSP
   unchanged.
9. **Data is never translated.** Typed text, names, catalogue and test names, specialities, addresses.
10. **Server text.** No server-side translation of error messages; unmapped codes show the server's English. PDFs, emails,
    the sign-in SMS and push stay English in phase 6.
11. **Two separate languages.** The care and SMS language (`preferredLanguage`) stays per booking, and phase 6 adds no
    control for it. The app language (`uiLanguage`) is separate.
12. **Language names.**
    - The switcher shows each language in its own script, never translated.
    - The patient-language list uses catalogue words.
    - "Jansetu" stays in Latin letters.
13. **Backend values.** `uiLanguage` accepts any 2–3 letter code; the apps ignore codes they have not released.
14. **Pseudo.** The pseudo-language exists only in development and tests.

## 8. Questions for the owner

1. **Answered 2026-11-25: machine only (IndicTrans2), no checker.** The question was: who drafts and who checks each
   language?
   Recommended:
   - We draft with machine help from an agreed glossary.
   - One paid native-speaker checker per language with a health-care background (for example a pharmacist from a
     partner in Assam, Bengal, Odisha or a Hindi-speaking state) corrects every string, then checks the screens on stage.
   - Consent, money and refund sentences get a second checker.
   - Please name the checkers.
2. **In which language is the patient's consent shown and recorded at a partner booking?**
   Recommended:
   - The patient's chosen language when a consent text exists for it (the five first-wave languages); else the
     screen's language.
   - `statementLanguage` records the language shown.
   - Each translated consent is approved by the legal reviewer before use (GATE-DPDP).
3. **Do PDFs (bills, the prescription copy) stay English in phase 6?**
   Recommended: yes. Bills are tax documents and prescriptions name medicines in English. Bilingual headings can follow
   later if partners ask.
4. **Should Jansetu's own admin screens be translated?**
   Recommended: build them the same way (round 6j, one code path), but order their translation last. Admins see English
   for any admin text not yet translated.
5. **Release each language when it is ready, or all five together?**
   Recommended: per app and per language as soon as it passes the 95% check (95% present, 2026-11-25). Customer app
   first, Hindi likely first.

## 9. Effort

Build days are for one builder; each round then gets one independent review (about half a day).

| Round | Build | Notes |
|---|---|---|
| 6a | 3 days | Core, format, switcher, checks, start-up spec (built) |
| 6a2 | 1.5 days | Translator script, fonts and CSS, typed digits, save to the account |
| 6a-backend | 1 day | Model field, route, integration test |
| 6b | 3 days | api words are many short maps; plurals; one `messageOf` |
| 6c | 3 days | Customer app; session notices |
| 6d | 2 days | Shell, sign-in, shared components, finance |
| 6e | 2.5 days | Pharmacy operations |
| 6f | 3 days | Many money sentences; consent per language |
| 6g | 3 days | Lab and bills |
| 6h | 2.5 days | Clinic and partner team |
| 6i | 2 days | Doctor |
| 6j | 3 days | Admin |
| 6k | 0.5–1 day per app and language (up to 8) | Import, smoke spec, 360 px check, fixes |
| **Total** | **≈ 29 build days + ≈ 6 review days, then 4–8 days of releases** | §13's "L + translation time" |

**Translation time** (machine only, 2026-11-25): about 28,000 English words per language, about 112,000 for the four.
An IndicTrans2 run takes hours, not weeks, so a language can be released as soon as its app's extraction rounds are
done and the run has made 95% of its words. (The WQ30 estimate of about 3 weeks of native checking no longer applies.)
