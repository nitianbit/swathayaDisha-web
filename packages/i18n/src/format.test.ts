import { CALENDAR_DATE, CALENDAR_DAY, formatClock, formatDateTime, formatDateWith, formatPaise, formatRupees, formatYmd, INDIA_TIME } from './format.ts';
import { setLanguage } from './index.ts';

// The helpers these replace, as they were: English output must stay byte-identical.
const before = {
  rupees: (v: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(v),
  dateTime: (d: Date) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(d),
  ymd: (s: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)))),
  clockGb: (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(d),
  day: (iso: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(Date.parse(`${iso}T00:00:00Z`)),
  appointment: (d: Date) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(d),
};

afterEach(async () => { await setLanguage('en'); });

const instants = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, i % 12, 1 + (i % 28), (i * 7) % 24, (i * 13) % 60)));

describe('English output is unchanged', () => {
  it('money', () => {
    for (const v of [0, 1, 99.5, 1234.56, 123456.5, 10_000_000, -42.1]) expect(formatRupees(v)).toBe(before.rupees(v));
    expect(formatRupees(123456.5)).toBe('₹1,23,456.50');
    expect([formatRupees(undefined), formatRupees(null), formatRupees(Number.NaN)]).toEqual(['—', '—', '—']);
    expect(formatPaise(12345)).toBe(before.rupees(123.45));
  });

  it('dates and times', () => {
    for (const d of instants) {
      expect(formatDateTime(d.toISOString())).toBe(before.dateTime(d));
      expect(formatClock(d)).toBe(before.clockGb(d));
      expect(formatDateWith(d, { hour: 'numeric', minute: '2-digit', timeZone: INDIA_TIME })).toBe(before.appointment(d));
      const iso = d.toISOString().slice(0, 10);
      expect(formatYmd(iso.replace(/-/g, ''))).toBe(before.ymd(iso.replace(/-/g, '')));
      expect(formatDateWith(Date.parse(`${iso}T00:00:00Z`), CALENDAR_DAY)).toBe(before.day(iso));
    }
    expect(formatYmd('20261122')).toBe('22 Nov 2026');
    expect([formatDateTime(''), formatDateTime('not a date'), formatDateTime(null)]).toEqual(['—', '—', '—']);
  });
});

describe('other languages', () => {
  it('dates use the language’s month names with digits 0-9; money is the same everywhere', async () => {
    const d = new Date('2026-11-25T09:05:00Z');
    for (const lang of ['hi', 'as', 'bn', 'or'] as const) {
      await setLanguage(lang);
      const text = formatDateWith(d, CALENDAR_DATE);
      expect(text).toMatch(/2026/);
      expect(text).not.toMatch(/Nov/);
      expect(formatDateTime(d.toISOString())).not.toMatch(/[०-९০-৯୦-୯]/);
      expect(formatRupees(123456.5)).toBe('₹1,23,456.50');
    }
    await setLanguage('hi');
    expect(formatDateWith(d, CALENDAR_DATE)).toBe('25 नव॰ 2026');
  });
});
