import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from './client.ts';
import {
  cleanRecommendationCode, formatRecommendationCode, matchRecommended, pharmacyRecommendationsApi, recommendationRefusal, recommendationsOff,
} from './assistedLab.ts';

// WQ21 (backend r16 phase 3d, design §25.12.4): the recommended-tests code at the pharmacy.

describe('the recommended-tests code', () => {
  it('cleans what is typed, and prints it as on the prescription', () => {
    expect(cleanRecommendationCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(cleanRecommendationCode('ab cd ef gh')).toBe('ABCDEFGH');
    expect(cleanRecommendationCode('ab')).toBeNull();
    expect(cleanRecommendationCode('ABCD/EFGH')).toBeNull();
    expect(formatRecommendationCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('loads by code and number; a malformed code is never sent', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
      calls.push({ url: String(u), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ success: true, data: { code: 'ABCDEFGH', status: 'open', items: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
    const api = pharmacyRecommendationsApi(c);
    await expect(api.load('abcd-efgh', '9876543210')).resolves.toMatchObject({ code: 'ABCDEFGH' });
    expect(() => api.load('a/b', '9876543210')).toThrow('Invalid recommendation code');
    // r16b: the code and the number in the body, never in the URL.
    expect(calls).toEqual([{ url: '/api/v1/pharmacy-assisted/recommendations/lookup', method: 'POST', body: { code: 'ABCDEFGH', phone: '9876543210' } }]);
  });

  it('ticks only exact names (case and spaces aside) and says the rest', () => {
    const items = [{ itemId: 'a', name: 'Complete Blood Count' }, { itemId: 'b', name: 'Thyroid profile' }, { itemId: 'c', name: 'Lipid profile (fasting)' }];
    expect(matchRecommended(items, ['complete  blood count', ' THYROID PROFILE', 'Lipid profile', 'Thyroid profile'])).toEqual({ itemIds: ['a', 'b'], unmatched: ['Lipid profile'] });
  });

  it('refusals in plain words; the switch off hides the field', () => {
    const e = (status: number, code?: string) => new ApiError(status, 'x', code);
    expect(recommendationRefusal(e(400, 'INVALID_CODE'))).toBe('This code is not valid. Check it on the prescription.');
    expect(recommendationRefusal(e(404, 'RECOMMENDATION_NOT_FOUND'))).toBe('No recommended tests were found for this code and this mobile number. Check both with the patient.');
    expect(recommendationRefusal(e(400, 'INVALID_PHONE'))).toBe('Enter a valid 10-digit mobile number.');
    expect(recommendationsOff(e(503, 'RECOMMENDATIONS_DISABLED'))).toBe(true);
    expect(recommendationsOff(e(404))).toBe(true); // a server without the route
    expect(recommendationsOff(e(404, 'RECOMMENDATION_NOT_FOUND'))).toBe(false);
  });
});

describe('WQ21b: the lab desk lookup', () => {
  it('posts the code and the number to the desk route (and its admin mirror); 403 from a non-lab hides the field', async () => {
    const { labDeskApi } = await import('./labDesk.ts');
    const calls: { url: string; body: unknown }[] = [];
    const c = createApiClient({ baseUrl: '', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async (u, init) => {
      calls.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ success: true, data: { code: 'ABCDEFGH', status: 'open', items: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
    await labDeskApi(c, { kind: 'member' }).recommendation('abcd-efgh', '9876543210');
    await labDeskApi(c, { kind: 'admin', partnerId: 'a1'.repeat(12) }).recommendation('ABCDEFGH', '9876543210');
    expect(calls).toEqual([
      { url: '/api/v1/partner-workspace/lab-desk/recommendations/lookup', body: { code: 'ABCDEFGH', phone: '9876543210' } },
      { url: `/api/v1/partner-workspace/admin/${'a1'.repeat(12)}/workspace/lab-desk/recommendations/lookup`, body: { code: 'ABCDEFGH', phone: '9876543210' } },
    ]);
    expect(recommendationsOff(new ApiError(403, 'x', 'LAB_PARTNER_REQUIRED'))).toBe(true);
    expect(recommendationsOff(new ApiError(403, 'x', 'PARTNER_NOT_VERIFIED'))).toBe(true);
    expect(recommendationsOff(new ApiError(403, 'x', 'INSUFFICIENT_PERMISSIONS'))).toBe(false);
  });
});
