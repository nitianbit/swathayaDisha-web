import { describe, expect, it } from 'vitest';
import { ApiError } from './client.ts';
import { assistedRefusal, labBookerRefusal, rescheduleRefusal } from './assisted.ts';
import { agreementProblem, cardRefundCauseLabel, payerNameOf, payerWord } from './assistedCard.ts';

// WQ24b (backend r21, §24.17.3): admin card refund rows name their payer; a lab's refusals are said in the lab's words.

describe('the payer of a card refund row', () => {
  it('is a pharmacy, a lab or a doctor; an older answer (no payerKind) is a pharmacy', () => {
    expect(payerWord('lab')).toBe('lab');
    expect(payerWord('doctor')).toBe('doctor');
    expect(payerWord('pharmacy')).toBe('pharmacy');
    expect(payerWord(undefined)).toBe('pharmacy');
    expect(payerWord('something-new')).toBe('pharmacy');
  });

  it('is named by payerName, else an older answer’s pharmacyName, else not at all', () => {
    expect(payerNameOf({ payerName: 'City Lab' })).toBe('City Lab');
    expect(payerNameOf({ payerName: 'Asha Medicals', pharmacyName: 'Asha Medicals' })).toBe('Asha Medicals');
    expect(payerNameOf({ pharmacyName: 'Asha Medicals' })).toBe('Asha Medicals');
    expect(payerNameOf({ payerName: null, pharmacyName: null })).toBeNull();
  });

  it('says who cancelled and whose agreement it is in the payer’s words (the pharmacy’s unchanged)', () => {
    expect(cardRefundCauseLabel('booker')).toBe('Cancelled by the pharmacy');
    expect(cardRefundCauseLabel('booker', 'lab')).toBe('Cancelled by the lab');
    expect(cardRefundCauseLabel('booker', 'doctor')).toBe('Cancelled by the doctor');
    expect(cardRefundCauseLabel('patient', 'lab')).toBe('Cancelled by the patient');
    expect(cardRefundCauseLabel('extra_capture', 'lab')).toBe('Second payment, refunded');
    expect(cardRefundCauseLabel('unknown_cause', 'lab')).toBeUndefined();
    expect(agreementProblem('  ')).toMatch(/^Write what the pharmacy agreed to, and how \(for example “Agreed on a call with the owner/);
    expect(agreementProblem('  ', 'lab')).toMatch(/^Write what the lab agreed to/);
    expect(agreementProblem('  ', 'doctor')).toMatch(/^Write what the doctor agreed to, and how \(for example “Agreed on a call with the doctor/);
    expect(agreementProblem('ok', 'lab')).toBeUndefined();
  });
});

describe('a reschedule refusal in the booker’s words', () => {
  const e = (status: number, code?: string, message = 'Partner verification is required for this operation') => new ApiError(status, message, code);
  it('keeps the reschedule words, and says anything else as the booker does', () => {
    expect(rescheduleRefusal(e(409, 'SLOT_NOT_AVAILABLE'), labBookerRefusal)).toMatchObject({ kind: 'slot' });
    expect(rescheduleRefusal(e(403, 'PARTNER_NOT_VERIFIED'), labBookerRefusal).message).toBe('Your lab is not verified yet, so it cannot book for patients.');
    expect(rescheduleRefusal(e(403, 'BRANCH_SCOPE_EXCEEDED'), labBookerRefusal).message).toBe('This branch is not one of yours. Choose one of your branches.');
    // The pharmacy's default is unchanged.
    expect(rescheduleRefusal(e(403, 'PARTNER_NOT_VERIFIED')).message).toBe(assistedRefusal(e(403, 'PARTNER_NOT_VERIFIED')).message);
    expect(rescheduleRefusal(e(503, 'ASSISTED_BOOKING_DISABLED'), labBookerRefusal).message).toBe('Booking for patients is not switched on yet.');
  });
});
