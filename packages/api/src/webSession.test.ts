import { ApiError } from './client.ts';
import { clearWebSignOutPending, isTransientSessionError, markerStore, markWebSignOutPending, webSignOutState } from './webSession.ts';

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

describe('WQ11a reload markers', () => {
  afterEach(() => sessionStorage.clear());
  it('clear() forgets one person\'s markers in one app only', () => {
    const m = { requestKey: 'abcdefgh12', attempts: 1, firstAttemptAt: 1, lastAttemptAt: 1 };
    markerStore('customer', 'u1').save('lab-create:x', m);
    markerStore('customer', 'u1').save('instant-create', m);
    markerStore('customer', 'u2').save('lab-create:x', m);
    markerStore('workspace', 'u1').save('return', m);
    markerStore('customer', 'u1').clear();
    expect(markerStore('customer', 'u1').all()).toEqual({});
    expect(Object.keys(markerStore('customer', 'u2').all())).toEqual(['lab-create:x']);
    expect(Object.keys(markerStore('workspace', 'u1').all())).toEqual(['return']);
  });
});
