import { createApiClient } from '@jansetu/api';
import { paymentCheck } from './payments.ts';

const RECORD = '9'.repeat(24);
const clientAnswering = (status: number, body: unknown) => createApiClient({
  baseUrl: '', getToken: () => 't', fetchImpl: async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
});

describe('WQ11a payment check answers', () => {
  it('a definite refusal of the check (failed or refunded attempt) lets a new payment start', async () => {
    expect(await paymentCheck(clientAnswering(400, { error: 400, code: 'PAYMENT_FAILED', message: 'x' }), RECORD)).toEqual({ outcome: 'unpaid', returned: false });
    expect(await paymentCheck(clientAnswering(400, { error: 400, code: 'PAYMENT_REFUNDED', message: 'x' }), RECORD)).toEqual({ outcome: 'unpaid', returned: true });
  });
  it('no answer, or any other refusal, is "could not check"', async () => {
    expect((await paymentCheck(clientAnswering(503, { error: 503 }), RECORD)).outcome).toBe('unknown');
    expect((await paymentCheck(clientAnswering(400, { error: 400, code: 'PAYMENT_NOT_RECONCILABLE' }), RECORD)).outcome).toBe('unknown');
  });
  it('a capture returned to the wallet is not "paid"', async () => {
    expect(await paymentCheck(clientAnswering(200, { success: true, data: { state: 'paid', paymentRecord: { status: 'refunded' } } }), RECORD))
      .toEqual({ outcome: 'unpaid', returned: true });
    expect(await paymentCheck(clientAnswering(200, { success: true, data: { state: 'paid', paymentRecord: { status: 'paid' } } }), RECORD))
      .toEqual({ outcome: 'paid', returned: false });
  });
});
