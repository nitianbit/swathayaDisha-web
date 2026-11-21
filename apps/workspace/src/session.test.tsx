import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PARTNER_NEEDS_SAME_ORIGIN, SessionProvider, useSession } from './session.tsx';

/** Q16b: in a build whose API is on another origin there is no cookie session, and partners get no bearer token. */
describe('partner sign-in in a cross-origin (bearer) build', () => {
  afterEach(() => vi.unstubAllGlobals());

  function mount() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { token: 't', user: {} } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    let session!: ReturnType<typeof useSession>;
    function Probe() { session = useSession(); return null; }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider baseUrl="https://api.example.test"><Probe /></SessionProvider>
      </QueryClientProvider>,
    );
    return { fetchMock, get: () => session };
  }

  it('is refused with a clear message before any code is sent or verified', async () => {
    const { fetchMock, get } = mount();
    await waitFor(() => expect(get().state.status).toBe('signed_out'));
    await act(async () => {
      await expect(get().requestCode('partner', { phone: '9876543210' })).rejects.toMatchObject({ code: 'PARTNER_NEEDS_SAME_ORIGIN', message: PARTNER_NEEDS_SAME_ORIGIN });
      await expect(get().verifyCode('partner', { phone: '9876543210' }, '123456')).rejects.toMatchObject({ code: 'PARTNER_NEEDS_SAME_ORIGIN' });
      await expect(get().choosePartner('tk', 'a1'.repeat(12))).rejects.toMatchObject({ code: 'PARTNER_NEEDS_SAME_ORIGIN' });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('other staff still sign in with the bearer path there', async () => {
    const { fetchMock, get } = mount();
    await waitFor(() => expect(get().state.status).toBe('signed_out'));
    await act(async () => { await get().requestCode('pharmacy', { phone: '9876543210' }); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://api.example.test/api/v1/auth/pharmacy/send');
  });
});
