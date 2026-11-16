import type { ClinicAppointment } from '@jansetu/api';
import { deskBookingSlot, lookalikes } from './desk.ts';

const S1 = 'e1'.repeat(12);
const S2 = 'e2'.repeat(12);
const row = (o: Partial<ClinicAppointment>): ClinicAppointment => ({
  bookingId: 'k1'.repeat(12), bookingDate: '20261117', bookingTime: '10:30', status: 'confirmed', doctorId: 'd1'.repeat(12), branchId: 'c1'.repeat(12),
  slotId: S1, payAtClinic: true, arrivedAt: null, source: 'desk', paidOnline: false, patient: { name: 'Asha', phone: '9800000001' }, ...o,
});

describe('desk booking recovery helpers', () => {
  it('keeps the unconfirmed booking per workspace', () => {
    expect(deskBookingSlot('partner-ws:member:x')).toBe('clinic-desk:book:partner-ws:member:x');
  });

  it('finds desk appointments at the same slot for the same mobile (any written form), never cancelled or online ones', () => {
    const rows = [
      row({ bookingId: 'a' }),
      row({ bookingId: 'b', slotId: S2 }),
      row({ bookingId: 'c', status: 'cancelled' }),
      row({ bookingId: 'd', source: 'online' }),
      row({ bookingId: 'e', patient: { phone: '9800000002' } }),
      row({ bookingId: 'f', patient: {} }),
    ];
    expect(lookalikes(rows, { slotId: S1, customer: { phone: '+91 98000 00001' } }).map((r) => r.bookingId)).toEqual(['a']);
    expect(lookalikes(rows, { slotId: S1, customer: { phone: 'bad' } })).toEqual([]);
  });
});
