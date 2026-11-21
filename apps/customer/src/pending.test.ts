import { ApiError } from '@jansetu/api';
import { afterFailure, beginAttempt, settleByAbandon, startOp, stillCurrent } from './pending.ts';

describe('booking request rules', () => {
  it('forgets a request only when its sole first attempt is definitely refused', () => {
    const first = beginAttempt(startOp({ a: 1 }));
    expect(afterFailure(first, new ApiError(400, 'Slot full'), 'x')).toBeNull();
    expect(afterFailure(first, new ApiError(0, 'no answer'), 'no answer')).toMatchObject({ uncertain: true, body: { a: 1 } });
    const resend = beginAttempt(afterFailure(first, new ApiError(0, 'x'), 'x')!);
    expect(afterFailure(resend, new ApiError(409, 'Slot full', 'SLOT_FULL'), 'x')).toMatchObject({ uncertain: true, attempts: 2 });
    expect(resend.requestKey).toBe(first.requestKey);
  });
  it('WQ11a N5: a resend refused for good is never settled locally: it is settled by the server\'s abandon', () => {
    const first = beginAttempt(startOp({ a: 1 }));
    expect(settleByAbandon(first, new ApiError(400, 'x'))).toBe(false); // a sole first attempt: its refusal is the answer
    const resend = beginAttempt(afterFailure(first, new ApiError(0, 'x'), 'x')!);
    for (const err of [new ApiError(400, 'Slot', 'SLOT_NOT_AVAILABLE'), new ApiError(409, 'x', 'REQUEST_ABANDONED'), new ApiError(422, 'x'), new ApiError(409, 'x', 'SLOT_FULL')]) {
      expect(afterFailure(resend, err, 'x')).toMatchObject({ uncertain: true, attempts: 2 });
      expect(settleByAbandon(resend, err)).toBe(true);
    }
    for (const err of [new ApiError(0, 'x'), new ApiError(503, 'x'), new ApiError(429, 'x')]) expect(settleByAbandon(resend, err)).toBe(false);
  });
  it('lets only the newest attempt change the stored state', () => {
    const a = beginAttempt(startOp({}));
    const b = beginAttempt(a);
    expect(stillCurrent(b, a)).toBe(false);
    expect(stillCurrent(b, b)).toBe(true);
  });
});
