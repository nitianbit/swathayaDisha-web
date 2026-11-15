import { createApiClient } from './client.ts';
import { billFileName, customerBillsApi, gstSplit } from './customerBills.ts';

const I = 'c1'.repeat(12);

function setup(res: () => Response) {
  const calls: string[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok', timeoutMs: 50,
    fetchImpl: async (input) => { calls.push(String(input)); return res(); } });
  return { api: customerBillsApi(client), calls };
}

describe('customer bills api', () => {
  it('lists bills and orders a bill’s events by version', async () => {
    const { api, calls } = setup(() => new Response(JSON.stringify({ success: true, data: {
      invoice: { _id: I }, events: [{ kind: 'cancellation', version: 2, at: 'b' }, { kind: 'payment', version: 1, at: 'a' }] } })));
    const r = await api.bill(I);
    expect(r.events.map((e) => e.kind)).toEqual(['payment', 'cancellation']);
    expect(calls[0]).toBe(`https://api.example.test/api/v1/bills/${I}`);
  });
  it('reads the PDF as bytes with the token, and refuses a malformed id before calling', async () => {
    const { api, calls } = setup(() => new Response('%PDF-1.4', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    expect(await (await api.pdf(I)).text()).toBe('%PDF-1.4');
    expect(calls[0]).toBe(`https://api.example.test/api/v1/bills/${I}/pdf`);
    expect(() => api.pdf('x/../../admins')).toThrow('Invalid bill id');
  });
  it('treats an odd list answer as no bills', async () => {
    const { api } = setup(() => new Response(JSON.stringify({ success: true, data: null })));
    await expect(api.bills()).resolves.toEqual([]);
  });
});

describe('GST split', () => {
  const t = { subtotalMinor: 0, discountMinor: 0, taxableMinor: 0, totalMinor: 0, currency: 'INR' as const };
  it('shows CGST + SGST within a state and IGST across states; zero parts left out', () => {
    expect(gstSplit({ ...t, cgstMinor: 900, sgstMinor: 900, igstMinor: 0 })).toEqual([{ label: 'CGST', minor: 900 }, { label: 'SGST', minor: 900 }]);
    expect(gstSplit({ ...t, cgstMinor: 0, sgstMinor: 0, igstMinor: 1800 })).toEqual([{ label: 'IGST', minor: 1800 }]);
    expect(gstSplit({ ...t, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 })).toEqual([]);
  });
  it('names the file from the serial and version', () => {
    expect(billFileName({ serial: 'LAB/2026-27/000123', lifecycleVersion: 1 })).toBe('LAB-2026-27-000123-v1.pdf');
  });
});
