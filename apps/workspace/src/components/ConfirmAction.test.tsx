import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@jansetu/api';
import { CHANGED_WHILE_OPEN, ConfirmAction } from './ConfirmAction.tsx';

/**
 * WQ11b (review proof "confirm-carryover"): Deactivate and Activate share one position. A refusal re-reads the record
 * before the answer reaches the confirmation, so the step under it changes: the confirmation must close (the refusal shown
 * next to the trigger, named), never stay open as the opposite step.
 */
function StateLike({ sent }: { sent: boolean[] }) {
  const [active, setActive] = useState(true);
  const act = async (isActive: boolean) => {
    sent.push(isActive);
    try {
      if (sent.length === 1) throw new ApiError(409, 'Care Chemist was changed by someone else meanwhile, so nothing was changed.', 'RECORD_CHANGED');
    } finally {
      setActive(sent.length === 1 ? false : isActive); // the re-read shows what is saved
    }
  };
  return active
    ? <ConfirmAction label="Deactivate" danger confirmLabel="Deactivate Care Chemist" consequence="It can no longer sign in." onConfirm={() => act(false)} />
    : <ConfirmAction label="Activate" confirmLabel="Activate Care Chemist" consequence="It can sign in again." onConfirm={() => act(true)} />;
}

test('a refused step whose record was read again closes; the refusal is shown next to the new trigger, and nothing more is sent', async () => {
  const sent: boolean[] = [];
  const user = userEvent.setup();
  render(<StateLike sent={sent} />);
  await user.click(screen.getByRole('button', { name: 'Deactivate' }));
  await user.click(screen.getByRole('button', { name: 'Deactivate Care Chemist' }));
  await screen.findByRole('button', { name: 'Activate' });
  expect(screen.queryByRole('group')).toBeNull(); // no confirmation left open for the opposite step
  expect(screen.queryByRole('button', { name: 'Activate Care Chemist' })).toBeNull();
  expect(screen.getByText(/Deactivate Care Chemist: Care Chemist was changed by someone else meanwhile/)).toBeInTheDocument();
  expect(sent).toEqual([false]);
});

test('a confirmation opened on one version closes when the record moves while it is open; it sends the version it was opened on', async () => {
  const user = userEvent.setup();
  const seen: (string | number | undefined)[] = [];
  function Host() {
    const [v, setV] = useState('v1');
    return (
      <>
        <button type="button" onClick={() => setV('v2')}>someone else saves</button>
        <ConfirmAction label="Verify" confirmLabel="Verify Care Chemist" consequence="Customers can find it." version={v}
          onConfirm={async (_r, openedOn) => { seen.push(openedOn); }} />
      </>
    );
  }
  render(<Host />);
  await user.click(screen.getByRole('button', { name: 'Verify' }));
  await user.click(screen.getByRole('button', { name: 'someone else saves' }));
  expect(screen.queryByRole('group', { name: 'Verify' })).toBeNull();
  expect(screen.getByText(CHANGED_WHILE_OPEN)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Verify' }));
  await user.click(screen.getByRole('button', { name: 'Verify Care Chemist' }));
  await waitFor(() => expect(seen).toEqual(['v2']));
});

test('keyboard focus goes to the first control when it opens, and back to the trigger on Back (review proof "focus")', async () => {
  const user = userEvent.setup();
  render(<ConfirmAction label="Cancel appointment" danger reason="optional" confirmLabel="Cancel appointment" consequence="Cancel it?" onConfirm={async () => undefined} />);
  screen.getByRole('button', { name: 'Cancel appointment' }).focus();
  await user.keyboard('{Enter}');
  const group = screen.getByRole('group', { name: 'Cancel appointment' });
  await waitFor(() => expect(document.activeElement).toBe(group.querySelector('textarea')));
  screen.getByRole('button', { name: 'Back' }).focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel appointment' })));
});