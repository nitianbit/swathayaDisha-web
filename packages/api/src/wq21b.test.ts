import { describe, expect, it } from 'vitest';
import { isCardAnswer, routeCardAnswer } from './assistedCard.ts';

// WQ21 L1: one router for a create's answer and a by-key `used` answer, for both booking kinds.

function route(kind: 'consultation' | 'lab', a: Parameters<typeof routeCardAnswer>[1], byKey: { restored: boolean } | null) {
  const seen: string[] = [];
  const left = routeCardAnswer(kind, a, byKey, { settle: () => seen.push('settle'), done: (card) => seen.push(`done:${card}`), due: () => seen.push('due'), ended: () => seen.push('ended') });
  return { left, seen };
}

describe('routeCardAnswer', () => {
  it('wallet → done; card paid / waiting / ended, by kind', () => {
    expect(route('consultation', { card: false, booking: { status: 'confirmed' }, order: null }, null).seen).toEqual(['settle', 'done:false']);
    expect(route('consultation', { card: true, booking: { status: 'confirmed', paymentStatus: 'paid' }, order: null }, null).seen).toEqual(['settle', 'done:true']);
    expect(route('consultation', { card: true, booking: { status: 'pending', paymentStatus: 'pending' }, order: 'o' }, null).seen).toEqual(['settle', 'due']);
    expect(route('lab', { card: true, booking: { status: 'pending_payment' }, order: 'o' }, null).seen).toEqual(['settle', 'due']);
    expect(route('lab', { card: true, booking: { status: 'cancelled' }, order: null }, null).seen).toEqual(['settle', 'ended']);
  });

  it('found by key, waiting without its order: the same request again (nothing settled), unless only the key is left', () => {
    expect(route('lab', { card: true, booking: { status: 'pending_payment' }, order: null }, { restored: false }))
      .toEqual({ left: 'The booking is held, but its card payment could not be started. Send the same request again to get the payment page.', seen: [] });
    expect(route('lab', { card: true, booking: { status: 'pending_payment' }, order: null }, { restored: true }).seen).toEqual(['settle', 'due']);
  });

  it('a card answer: `payment` present, or the view says card', () => {
    expect(isCardAnswer({ booking: {}, payment: null } as never)).toBe(true);
    expect(isCardAnswer({ booking: { payment: { method: 'razorpay' } } })).toBe(true);
    expect(isCardAnswer({ booking: { payment: { method: 'wallet' } } })).toBe(false);
  });
});
