import { checkTranslation } from './check.ts';

const en = {
  title: 'Wallet',
  collect: 'Collect {amount} from {who}.',
  units: { one: '{count} unit', other: '{count} units' },
} as const;
const source = { title: 'Wallet', collect: 'Collect {amount} from {who}.', units: { one: '{count} unit', other: '{count} units' } };

describe('checkTranslation', () => {
  it('counts a complete, current translation', () => {
    const r = checkTranslation(en, 'hi', { title: 'वॉलेट', collect: '{who} से {amount} लें।', units: { one: 'एक यूनिट', other: '{count} यूनिट' } }, source);
    expect(r).toEqual({ problems: [], total: 3, translated: 3, missing: [] });
  });

  it('reports missing words without failing them', () => {
    expect(checkTranslation(en, 'bn', { title: 'ওয়ালেট' }, source)).toEqual({ problems: [], total: 3, translated: 1, missing: ['collect', 'units'] });
  });

  it('finds extra, misshapen, wrong plural, empty, misplaced and stale words', () => {
    const r = checkTranslation(en, 'hi', {
      gone: 'x',
      title: { one: 'a', other: 'b' },
      collect: '{who} से {total} लें।',
      units: { one: '{count}', other: '{count}', few: '{count}' },
    }, source);
    expect(r.problems).toEqual([
      { key: 'gone', kind: 'extra' }, { key: 'title', kind: 'shape' }, { key: 'collect', kind: 'placeholders' }, { key: 'units', kind: 'plural' },
    ]);
    expect(checkTranslation(en, 'hi', { title: ' ' }, source).problems).toEqual([{ key: 'title', kind: 'empty' }]);
    expect(checkTranslation(en, 'hi', { title: 'वॉलेट' }, { title: 'Purse' }).problems).toEqual([{ key: 'title', kind: 'stale' }]);
    expect(checkTranslation(en, 'hi', { title: 'वॉलेट' }, {}).problems).toEqual([{ key: 'title', kind: 'stale' }]);
  });
});
