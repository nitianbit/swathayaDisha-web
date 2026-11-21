import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { vi } from 'vitest';
import { ApiError } from '@jansetu/api';

const store = new Map<string, unknown>();
const memory = {
  get: <T,>(k: string) => store.get(k) as T | undefined,
  set: (k: string, v: unknown) => { store.set(k, v); },
  delete: (k: string) => { store.delete(k); },
};
vi.mock('../session.tsx', () => ({ useSession: () => ({ memory }) }));
const { NoShowMove } = await import('./NoShowMove.tsx');

/** The desk's use (always "offer"; the booking stays a no-show throughout). Two times to choose from. */
function mount() {
  const send = vi.fn();
  let bump: (n: number) => void = () => undefined;
  function Host() {
    const [readAt, setReadAt] = useState(Date.now());
    bump = (n) => setReadAt(n);
    return (
      <NoShowMove slot="no-show-move:test:b1" who="Asha Rao" missed="Tue, 17 Nov 2026, 09:30" state="offer" status="no_show"
        readAt={readAt} reading={false} disabled={false} version="2026-11-16T05:00:00.000Z" consequence="x"
        picker={(choose) => (
          <>
            <button type="button" onClick={() => choose({ slotId: 'a'.repeat(24), label: 'Wed, 18 Nov 2026, 11:00' })}>pick 11:00</button>
            <button type="button" onClick={() => choose({ slotId: 'b'.repeat(24), label: 'Wed, 18 Nov 2026, 11:30' })}>pick 11:30</button>
          </>
        )}
        send={send} reread={() => undefined} onNotice={() => undefined} onFailure={() => undefined} />
    );
  }
  render(<Host />);
  return { send, bump: (n: number) => act(() => bump(n)) };
}

beforeEach(() => store.clear());

test('WQ11b: a lost first send, then a refused resend, can be given a new time (a new key) once the booking is read again', async () => {
  const user = userEvent.setup();
  const { send, bump } = mount();
  send.mockRejectedValueOnce(new ApiError(0, 'Could not reach the server.', 'NETWORK'));
  send.mockRejectedValueOnce(new ApiError(409, 'Slot is not available for booking', 'SLOT_NOT_AVAILABLE'));
  send.mockResolvedValueOnce({ replayed: false });
  await user.click(screen.getByRole('button', { name: 'Reschedule no-show' }));
  await user.click(screen.getByRole('button', { name: 'pick 11:00' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: /^Move to/ }));
  await screen.findByRole('group', { name: 'Unconfirmed no-show move' });
  await user.click(screen.getByRole('button', { name: 'Send the same move again' }));
  expect(await screen.findByRole('group', { name: 'Unconfirmed no-show move' })).toHaveTextContent('That time is no longer free. Pick another time.');
  // Not before the booking is read after that attempt.
  expect(screen.queryByRole('button', { name: 'Choose a new time again' })).toBeNull();
  await bump(Date.now() + 60_000);
  await user.click(screen.getByRole('button', { name: 'Choose a new time again' }));
  await user.click(screen.getByRole('button', { name: 'Forget it and choose again' }));
  await user.click(screen.getByRole('button', { name: 'pick 11:30' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: /^Move to/ }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  const keys = send.mock.calls.map((c) => c[1] as string);
  expect(keys[1]).toBe(keys[0]); // the resend: same request
  expect(keys[2]).not.toBe(keys[0]); // the new time: a new move
  expect(send.mock.calls[2]![0]).toMatchObject({ slotId: 'b'.repeat(24) });
  await waitFor(() => expect(store.size).toBe(0));
});

test('WQ11b: a lost send stays resend-only while nothing says it was refused (no new time can be chosen)', async () => {
  const user = userEvent.setup();
  const { send, bump } = mount();
  send.mockRejectedValue(new ApiError(0, 'Could not reach the server.', 'NETWORK'));
  await user.click(screen.getByRole('button', { name: 'Reschedule no-show' }));
  await user.click(screen.getByRole('button', { name: 'pick 11:00' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: /^Move to/ }));
  await screen.findByRole('group', { name: 'Unconfirmed no-show move' });
  await bump(Date.now() + 60_000);
  expect(screen.queryByRole('button', { name: 'Choose a new time again' })).toBeNull();
});

test('WQ11b: Back from the confirmation starts the choice again (review proof 3: it kept the old choice)', async () => {
  const user = userEvent.setup();
  mount();
  await user.click(screen.getByRole('button', { name: 'Reschedule no-show' }));
  await user.click(screen.getByRole('button', { name: 'pick 11:00' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByRole('form', { name: 'Reschedule no-show' })).toHaveTextContent('Choose the new time.');
  expect(screen.getByRole('form', { name: 'Reschedule no-show' })).not.toHaveTextContent('to Wed, 18 Nov 2026, 11:00?');
});