import { appointmentInstant, canCancelNow } from './cancellationWindow.ts';

describe('cancellation window (mirrors the backend rule)', () => {
  it('reads the appointment as IST', () => {
    expect(appointmentInstant('20261120', '09:30')!.at.toISOString()).toBe('2026-11-20T04:00:00.000Z');
    expect(appointmentInstant('20261120', '9:30 PM')!.at.toISOString()).toBe('2026-11-20T16:00:00.000Z');
    expect(appointmentInstant('20261120', '12:00 AM')!.at.toISOString()).toBe('2026-11-19T18:30:00.000Z');
    expect(appointmentInstant('20261131', '09:00')).toBeNull();
    expect(appointmentInstant('20261120', '13:00 PM')).toBeNull();
    expect(appointmentInstant('2026-11-20', '09:00')).toBeNull();
  });
  it('closes 24 hours before a paid appointment, 48 before a Monday one; unpaid stays open until it starts', () => {
    const fri = '20261120'; // Friday
    const now = new Date('2026-11-19T04:00:00.000Z'); // exactly 24 h before 09:30 IST Friday
    expect(canCancelNow(fri, '09:30', true, new Date(now.getTime() - 1))).toMatchObject({ ok: true });
    expect(canCancelNow(fri, '09:30', true, now)).toEqual({ ok: false, reason: 'window_closed', cutoffHours: 24 });
    expect(canCancelNow(fri, '09:30', false, now)).toEqual({ ok: true, deadline: null });
    const mon = '20261123'; // Monday 09:30 IST = 04:00Z; 48 h earlier = Sat 04:00Z
    expect(canCancelNow(mon, '09:30', true, new Date('2026-11-21T04:00:00.000Z'))).toEqual({ ok: false, reason: 'window_closed', cutoffHours: 48 });
    expect(canCancelNow(mon, '09:30', true, new Date('2026-11-21T03:59:59.000Z'))).toMatchObject({ ok: true });
    expect(canCancelNow(fri, '09:30', true, new Date('2026-11-20T04:00:00.000Z'))).toEqual({ ok: false, reason: 'started' });
    expect(canCancelNow(fri, 'soon', true)).toEqual({ ok: false, reason: 'invalid_time' });
  });
  it('exempts unpaid bookings from every time check, as the backend does', () => {
    expect(canCancelNow('20261120', '09:30', false, new Date('2026-11-21T00:00:00.000Z'))).toEqual({ ok: true, deadline: null }); // started
    expect(canCancelNow('20261120', 'soon', false)).toEqual({ ok: true, deadline: null }); // unreadable legacy time
    expect(canCancelNow('bad', '09:30', false)).toEqual({ ok: true, deadline: null });
  });
});
