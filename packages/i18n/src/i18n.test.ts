import { catalogue, chooseLanguage, getLanguage, offeredLanguages, setLanguage, startLanguage, subscribeLanguage } from './index.ts';

const en = {
  title: 'Wallet',
  collect: 'Collect {amount} from {who}.',
  units: { one: '{count} unit', other: '{count} units' },
  'only.en': 'Only in English',
} as const;
const hiWords = { title: 'वॉलेट', collect: '{who} से {amount} लें।', units: { one: '{count} यूनिट', other: '{count} यूनिटें' } };
let hiLoads = 0;
const t = catalogue('test-core', en, {
  './hi.json': async () => { hiLoads++; return { default: hiWords }; },
  './bn.json': () => Promise.reject(new Error('offline')),
  './hi.source.json': async () => ({ default: {} }), // never read: only `<lang>.json` names a language
});

// Compile-time only: a wrong key, missing params or a wrong placeholder name do not typecheck.
const typeChecks = () => {
  // @ts-expect-error not a key of this catalogue
  t('nope');
  // @ts-expect-error the placeholders are required
  t('collect');
  // @ts-expect-error `amont` is not a placeholder of this text
  t('collect', { amont: 1, who: 'x' });
  // @ts-expect-error a plural needs its count
  t('units');
  // @ts-expect-error a text without placeholders takes none
  t('title', { x: 1 });
};
void typeChecks;

afterEach(async () => {
  await setLanguage('en');
  await startLanguage('customer', ['en']);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('t', () => {
  it('gives the English words, fills placeholders as written and picks the plural', () => {
    expect(t('title')).toBe('Wallet');
    expect(t('collect', { amount: '₹5.00', who: 'Asha' })).toBe('Collect ₹5.00 from Asha.');
    expect(t('units', { count: 1 })).toBe('1 unit');
    expect(t('units', { count: 0 })).toBe('0 units');
    expect(t('units', { count: 1500 })).toBe('1500 units'); // not regrouped: English stays as `${n}` wrote it
  });

  it('switches to a loaded language, keeps its word order and plurals, and falls back to English per word', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await setLanguage('hi')).toBe(true);
    expect(getLanguage()).toBe('hi');
    expect(document.documentElement.lang).toBe('hi');
    expect(t('title')).toBe('वॉलेट');
    expect(t('collect', { amount: '₹5.00', who: 'Asha' })).toBe('Asha से ₹5.00 लें।');
    expect(t('units', { count: 0 })).toBe('0 यूनिट'); // Hindi "one" covers 0 and 1
    expect(t('units', { count: 2 })).toBe('2 यूनिटें');
    expect(t('only.en')).toBe('Only in English');
    t('only.en');
    // Noted once, by key alone (never the params, which may hold a name).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('test-core:only.en');
    await setLanguage('en');
    await setLanguage('hi');
    expect(hiLoads).toBe(1);
    expect(t('collect', { amount: '₹5.00', who: 'Asha' })).toBe('Asha से ₹5.00 लें।');
  });

  it('changes nothing when a language cannot load, and the last call wins', async () => {
    expect(await setLanguage('bn')).toBe(false);
    expect(getLanguage()).toBe('en');
    const first = setLanguage('hi');
    const second = setLanguage('en');
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(getLanguage()).toBe('en');
  });

  it('pseudo: accented, bracketed and longer, placeholders untouched', async () => {
    expect(await setLanguage('pseudo')).toBe(true);
    expect(document.documentElement.lang).toBe('en');
    expect(t('title')).toBe('⟦Ŵåļļéţ ~~~⟧');
    expect(t('collect', { amount: '₹5.00', who: 'Asha' })).toMatch(/^⟦Çöļļéçţ ₹5\.00 ƒŕöɱ Asha\. ~+⟧$/);
  });

  it('inserts values exactly as given: no escaping, no second pass, no nesting, zero kept', () => {
    expect(t('collect', { amount: 0, who: '<b>Asha & {who}</b> $t(title)' })).toBe('Collect 0 from <b>Asha & {who}</b> $t(title).');
  });

  it('uses only words shaped like their English (a plain text for a plural shows English)', async () => {
    const odd = catalogue('test-shape', { n: { one: '{count} day', other: '{count} days' }, s: 'Day' } as const, {
      './hi.json': async () => ({ default: { n: '{count} दिन', s: { one: 'x', other: 'y' }, extra: 'z' } }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await setLanguage('hi')).toBe(true);
    expect(odd('n', { count: 2 })).toBe('2 days');
    expect(odd('s')).toBe('Day');
  });

  it('rich: text and elements in order; has: for keys made from codes', () => {
    const strong = { element: 'strong' };
    expect(t.rich('collect', { amount: strong, who: 'Asha' })).toEqual(['Collect ', strong, ' from ', 'Asha', '.']);
    expect(t.has('title')).toBe(true);
    expect(t.has('errors.SLOT_NOT_AVAILABLE')).toBe(false);
  });

  it('a catalogue registered while another language shows loads its words and tells the screens', async () => {
    await setLanguage('hi');
    const heard = vi.fn();
    const stop = subscribeLanguage(heard);
    const late = catalogue('test-late', { hello: 'Hello' } as const, { './hi.json': async () => ({ default: { hello: 'नमस्ते' } }) });
    expect(late('hello')).toBe('Hello');
    await vi.waitFor(() => expect(late('hello')).toBe('नमस्ते'));
    expect(heard).toHaveBeenCalled();
    stop();
  });
});

describe('startLanguage and chooseLanguage', () => {
  it('starts in English with nothing kept and an English browser, and stores nothing', async () => {
    await startLanguage('workspace');
    expect(getLanguage()).toBe('en');
    expect(offeredLanguages()).toEqual(['en']);
    expect(localStorage.length).toBe(0);
  });

  it('uses the kept language only when this app offers it', async () => {
    localStorage.setItem('jansetu.lang', 'hi');
    await startLanguage('customer', ['en']);
    expect(getLanguage()).toBe('en');
    await startLanguage('customer', ['en', 'hi']);
    expect(getLanguage()).toBe('hi');
  });

  it('else the first browser language the app offers', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'hi-IN', 'en-US']);
    await startLanguage('customer', ['en', 'hi']);
    expect(getLanguage()).toBe('hi');
  });

  it('keeps the pseudo-language in development', async () => {
    localStorage.setItem('jansetu.lang', 'pseudo');
    await startLanguage('workspace');
    expect(getLanguage()).toBe('pseudo');
  });

  it('a choice applies and keeps only the code on this device; a language not offered is refused', async () => {
    await startLanguage('customer', ['en', 'hi']);
    expect(await chooseLanguage('bn')).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(await chooseLanguage('hi')).toBe(true);
    expect(getLanguage()).toBe('hi');
    expect({ ...localStorage }).toEqual({ 'jansetu.lang': 'hi' });
  });
});
