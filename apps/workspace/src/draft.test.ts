import { changedFields, dirtyKeys, rebase, staleMessage } from './draft.ts';

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

  it('names the fields in plain words', () => {
    expect(staleMessage(['services', 'holidays'])).toMatch(/^Someone else changed the services and holidays while you were editing/);
  });
});
