import { ApiError } from './client.ts';
import { clearWebSignOutPending, isIdListSlot, isSignedOutAnswer, isTransientSessionError, markerStore, markWebSignOutPending, webSignOutState } from './webSession.ts';

describe('WQ11a web sign-out record', () => {
  afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });

  it('records a flag and a time only (no token, no person), per app, until cleared', () => {
    expect(webSignOutState('customer')).toBe('none');
    expect(markWebSignOutPending('customer', 1234)).toBe(true);
    expect(JSON.parse(localStorage.getItem('sd:signout:customer')!)).toEqual({ pending: true, at: 1234 });
    expect(webSignOutState('customer')).toBe('pending');
    expect(webSignOutState('workspace')).toBe('none');
    clearWebSignOutPending('customer');
    expect(webSignOutState('customer')).toBe('none');
  });

  it('falls back to sessionStorage when localStorage refuses the write', () => {
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (this === localStorage) throw new Error('QuotaExceededError');
      set.call(this, k, v);
    });
    expect(markWebSignOutPending('customer')).toBe(true);
    expect(sessionStorage.getItem('sd:signout:customer')).not.toBeNull();
    expect(webSignOutState('customer')).toBe('pending');
  });

  it('an unreadable record is "unknown" (treated as pending by the apps); nothing recordable is reported', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(webSignOutState('customer')).toBe('unknown');
    expect(markWebSignOutPending('customer')).toBe(false);
  });
});

describe('WQ11a session command failures', () => {
  it('only a missing answer, a timeout, 408, 429 or a server error is transient', () => {
    for (const s of [0, 408, 429, 500, 502, 503]) expect(isTransientSessionError(new ApiError(s, 'x'))).toBe(true);
    for (const s of [400, 401, 403, 404]) expect(isTransientSessionError(new ApiError(s, 'x'))).toBe(false);
    expect(isTransientSessionError(new ApiError(401, 'x', 'SESSION_ENDED'))).toBe(false);
    expect(isTransientSessionError(new Error('secure store busy'))).toBe(true);
  });
});

describe('WQ11a N4 logout answer', () => {
  it('only the backend\'s { signedOut: true } proves the session ended', () => {
    expect(isSignedOutAnswer({ signedOut: true })).toBe(true);
    for (const a of [null, undefined, '', '<html></html>', {}, { signedOut: 'true' }, { success: true }]) expect(isSignedOutAnswer(a)).toBe(false);
  });
});

describe('WQ11d id lists in the reload marker store', () => {
  afterEach(() => { sessionStorage.clear(); });
  it('keeps only record ids, only for the listed slots, per person; remove clears them', () => {
    const m = markerStore('workspace', 'u'.repeat(24));
    const slot = `stock-import-discarded:${'p'.repeat(24)}`;
    expect(isIdListSlot(slot)).toBe(true);
    m.saveIds(slot, ['a'.repeat(24), 'Asha Rao', 42, 'b'.repeat(24)]);
    m.saveIds('patient-notes:x', ['c'.repeat(24)]); // not an id-list slot: nothing stored
    expect(m.allIds()).toEqual({ [slot]: ['a'.repeat(24), 'b'.repeat(24)] });
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('Asha');
    expect(markerStore('workspace', 'v'.repeat(24)).allIds()).toEqual({});
    m.remove(slot);
    expect(m.allIds()).toEqual({});
  });
});
