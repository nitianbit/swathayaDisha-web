import { ApiError } from '@jansetu/api';
import { afterFailure, beginAttempt, startOp, stillCurrent } from './pending.ts';

describe('booking request rules', () => {
  it('forgets a request only when its sole first attempt is definitely refused', () => {
    const first = beginAttempt(startOp({ a: 1 }));
    expect(afterFailure(first, new ApiError(400, 'Slot full'), 'x')).toBeNull();
    expect(afterFailure(first, new ApiError(0, 'no answer'), 'no answer')).toMatchObject({ uncertain: true, body: { a: 1 } });
    const resend = beginAttempt(afterFailure(first, new ApiError(0, 'x'), 'x')!);
    expect(afterFailure(resend, new ApiError(400, 'Slot full'), 'x')).toMatchObject({ uncertain: true, attempts: 2 });
    expect(resend.requestKey).toBe(first.requestKey);
  });
  it('lets only the newest attempt change the stored state', () => {
    const a = beginAttempt(startOp({}));
    const b = beginAttempt(a);
    expect(stillCurrent(b, a)).toBe(false);
    expect(stillCurrent(b, b)).toBe(true);
  });
});
