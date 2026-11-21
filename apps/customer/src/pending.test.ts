import { ApiError } from '@jansetu/api';
import { afterFailure, beginAttempt, startOp, stillCurrent } from './pending.ts';

describe('booking request rules', () => {
  it('forgets a request only when its sole first attempt is definitely refused', () => {
    const first = beginAttempt(startOp({ a: 1 }));
    expect(afterFailure(first, new ApiError(400, 'Slot full'), 'x')).toBeNull();
    expect(afterFailure(first, new ApiError(0, 'no answer'), 'no answer')).toMatchObject({ uncertain: true, body: { a: 1 } });
    const resend = beginAttempt(afterFailure(first, new ApiError(0, 'x'), 'x')!);
    expect(afterFailure(resend, new ApiError(409, 'Slot full', 'SLOT_FULL'), 'x')).toMatchObject({ uncertain: true, attempts: 2 });
    expect(resend.requestKey).toBe(first.requestKey);
  });
  it('WQ11a: settles a resend as not made only on a given-up key or a content refusal', () => {
    const first = beginAttempt(startOp({ a: 1 }));
    const resend = beginAttempt(afterFailure(first, new ApiError(0, 'x'), 'x')!);
    expect(afterFailure(resend, new ApiError(409, 'Cancelled', 'REQUEST_ABANDONED'), 'x')).toBeNull();
    expect(afterFailure(resend, new ApiError(422, 'Unprocessable'), 'x')).toBeNull();
    expect(afterFailure(resend, new ApiError(400, 'Invalid'), 'x')).toBeNull();
    for (const err of [new ApiError(409, 'Full', 'SLOT_FULL'), new ApiError(409, 'Price', 'PRICE_CHANGED'), new ApiError(401, 'x'), new ApiError(403, 'x'), new ApiError(503, 'x')]) {
      expect(afterFailure(resend, err, 'x')).toMatchObject({ uncertain: true, attempts: 2 });
    }
  });
  it('lets only the newest attempt change the stored state', () => {
    const a = beginAttempt(startOp({}));
    const b = beginAttempt(a);
    expect(stillCurrent(b, a)).toBe(false);
    expect(stillCurrent(b, b)).toBe(true);
  });
});
