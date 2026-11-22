import { ApiError, createApiClient } from './client.ts';
import { adminPharmacyWalletApi, topupNotFoundWords } from './adminPharmacyWallet.ts';

// WQ14 (before production): the admin top-up by-key read and its words.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const client = (response: () => Response) =>
  createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok', timeoutMs: 100, fetchImpl: async () => response() });
const ID = 'a'.repeat(24);
const KEY = 'k'.repeat(32);

describe('admin top-up by-key read', () => {
  it('W3(a): a 503 (r8 B1 INDEXES_OUTDATED) or a 500 is thrown, never read as not found or as an older server', async () => {
    for (const [status, code] of [[503, 'INDEXES_OUTDATED'], [500, 'INTERNAL'], [500, undefined], [503, undefined]] as const) {
      const c = client(() => json(status, { error: status, ...(code ? { code } : {}), message: 'broken' }));
      const read = adminPharmacyWalletApi(c).topupByKey(ID, KEY);
      await expect(read).rejects.toBeInstanceOf(ApiError);
      await expect(read).rejects.toMatchObject({ status });
    }
  });
  it('W3(c): the exact read says "Not found"; the history search still says where it looked', () => {
    expect(topupNotFoundWords({ complete: true, searched: 0, exact: true }, false))
      .toBe('Not found so far. It may still be on its way. Look at the history again in a minute before adding money again.');
    expect(topupNotFoundWords({ complete: true, searched: 3 }, false))
      .toBe('Not found in the wallet history so far. It may still be on its way. Look at the history again in a minute before adding money again.');
    expect(topupNotFoundWords({ complete: true, searched: 0, exact: true }, true))
      .toBe('Not added so far. It may still be on its way. Sending the same request again is safe: the money is never added twice.');
  });
});
