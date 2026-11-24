const LETTERS: Readonly<Record<string, string>> = {
  a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', w: 'ŵ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', N: 'Ñ', O: 'Ö',
  P: 'Þ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', W: 'Ŵ', Y: 'Ý', Z: 'Ž',
};

/**
 * The pseudo-language (docs/I18N_PLAN.md §3.9): accented, bracketed and about 35% longer, `{placeholders}` untouched.
 * Plain English left on a screen is a missed word; clipped text is a layout that will break in a longer language.
 */
export function pseudo(text: string): string {
  const body = text.split(/(\{\w+\})/).map((part, i) => (i % 2 ? part : [...part].map((ch) => LETTERS[ch] ?? ch).join(''))).join('');
  const pad = '~'.repeat(Math.ceil(text.length * 0.35));
  return `⟦${body}${pad ? ` ${pad}` : ''}⟧`;
}
