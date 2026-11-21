import { canonical, changedFields, dirtyKeys, rebase, staleMessage } from './draft.ts';

describe('edit drafts keep their baseline', () => {
  const base = { name: 'Main', services: { inLab: true }, holidays: ['2026-12-25'] };

  it('sends only what the person changed, never an untouched field', () => {
    const s = { base, draft: { ...base, name: 'Main Road' } };
    expect(dirtyKeys(s)).toEqual(['name']);
    expect(changedFields(s)).toEqual({ name: 'Main Road' });
  });

  it('a newer server value moves untouched fields along without a conflict', () => {
    const s = { base, draft: { ...base, name: 'Main Road' } };
    const latest = { ...base, services: { inLab: false }, holidays: [] };
    const { next, conflicts } = rebase(s, latest);
    expect(conflicts).toEqual([]);
    expect(next.draft).toEqual({ name: 'Main Road', services: { inLab: false }, holidays: [] });
    expect(changedFields(next)).toEqual({ name: 'Main Road' }); // the old services/holidays are not resent
  });

  it('a field changed here and on the server is a conflict: reset to the saved value for review', () => {
    const s = { base: { permissions: ['a', 'b'] }, draft: { permissions: ['a', 'b', 'c'] } };
    const { next, conflicts } = rebase(s, { permissions: ['a'] }); // someone revoked b meanwhile
    expect(conflicts).toEqual(['permissions']);
    expect(next.draft.permissions).toEqual(['a']); // the revoked grant is not restored
    expect(changedFields(next)).toEqual({});
  });

  it('the same change on both sides is not a conflict', () => {
    const { conflicts, next } = rebase({ base: { x: 1 }, draft: { x: 2 } }, { x: 2 });
    expect(conflicts).toEqual([]);
    expect(changedFields(next)).toEqual({});
  });

  it('WQ11b: the person’s own save coming back canonical (trimmed, re-cased) is not someone else’s change', () => {
    const gst = rebase({ base: { gstin: '' }, draft: { gstin: '29abcde1234f1z5' } }, { gstin: '29ABCDE1234F1Z5' });
    expect(gst.conflicts).toEqual([]);
    expect(gst.next.draft.gstin).toBe('29ABCDE1234F1Z5');
    expect(rebase({ base: { name: 'City Lab' }, draft: { name: 'City Lab Plus ' } }, { name: 'City Lab Plus' }).conflicts).toEqual([]);
    expect(rebase({ base: { contactEmail: '' }, draft: { contactEmail: 'Info@CityLab.in' } }, { contactEmail: 'info@citylab.in' }).conflicts).toEqual([]);
    expect(rebase({ base: { a: { line1: 'x' } }, draft: { a: { line1: ' 4th  Block ' } } }, { a: { line1: '4th Block' } }).conflicts).toEqual([]);
    // A real change by someone else is still a conflict.
    expect(rebase({ base: { name: 'City Lab' }, draft: { name: 'City Lab Plus' } }, { name: 'Metro Lab' }).conflicts).toEqual(['name']);
    expect(canonical({ x: [' A  b '] })).toEqual({ x: ['a b'] });
  });

  it('names the fields in plain words', () => {
    expect(staleMessage(['services', 'holidays'])).toMatch(/^Someone else changed the services and holidays while you were editing/);
  });
});

describe('Q10 RECORD_CHANGED', () => {
  it('is recognised only by its status and code', async () => {
    const { ApiError } = await import('@jansetu/api');
    const { isRecordChanged } = await import('./draft.ts');
    expect(isRecordChanged(new ApiError(409, 'Someone else changed this meanwhile; reload and review', 'RECORD_CHANGED'))).toBe(true);
    expect(isRecordChanged(new ApiError(409, 'x', 'MEMBER_ALREADY_EXISTS'))).toBe(false);
    expect(isRecordChanged(new Error('x'))).toBe(false);
  });
});
