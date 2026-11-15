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
  it('reads exactly the requested version of the PDF as bytes, and refuses a malformed id or version before calling', async () => {
    const { api, calls } = setup(() => new Response('%PDF-1.4', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    expect(await (await api.pdf(I, 0)).text()).toBe('%PDF-1.4');
    expect(calls[0]).toBe(`https://api.example.test/api/v1/bills/${I}/pdf?version=0`);
    expect(() => api.pdf('x/../../admins', 1)).toThrow('Invalid bill id');
    expect(() => api.pdf(I, -1)).toThrow('Invalid bill version');
    expect(calls).toHaveLength(1);
  });
  it('pages the list (Q9) and treats an odd answer as no bills', async () => {
    const { api, calls } = setup(() => new Response(JSON.stringify({ success: true, data: [{ _id: I, doctorName: 'Dr. A' }], pagination: { page: 2, limit: 20, total: 21, totalPages: 2 } })));
    await expect(api.bills(2)).resolves.toMatchObject({ items: [{ _id: I, doctorName: 'Dr. A' }], page: 2, total: 21, totalPages: 2 });
    expect(calls[0]).toBe('https://api.example.test/api/v1/bills?page=2&limit=20');
    const odd = setup(() => new Response(JSON.stringify({ success: true, data: null })));
    await expect(odd.api.bills()).resolves.toMatchObject({ items: [] });
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
