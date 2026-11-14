import { useState, type ReactNode } from 'react';
import { Alert, Button } from '@jansetu/ui';
import type { Page } from '@jansetu/api';
import { messageOf } from '../errors.ts';
import { findByKey, provenNotRecorded, type PendingOp } from '../requests.ts';

interface Props<B, R extends { requestKey?: string; createdAt?: string }> {
  label: string;
  op: PendingOp<B>;
  summary: ReactNode;
  busy: boolean;
  /** Resend exactly `op` (same key, same details). */
  onResend: () => void;
  /** Newest-first list in which a recorded `op` would appear. */
  fetchPage: (page: number) => Promise<Page<R>>;
  onFound: (record: R) => void;
  /** D4: forget a restored request that was provably never recorded (then a new one can be made). */
  onDiscard?: () => void;
}

/**
 * A submission whose outcome is not known. It can only be resent unchanged (safe: the server answers a repeated key
 * with the first record) or looked up in the records to show its receipt. Nothing here concludes "not recorded".
 * Render with `key={op.attempts}` so a lookup result never outlives a later attempt.
 */
export function PendingOpPanel<B, R extends { requestKey?: string; createdAt?: string }>(
  { label, op, summary, busy, onResend, fetchPage, onFound, onDiscard }: Props<B, R>,
) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const [notRecorded, setNotRecorded] = useState(false);

  async function check() {
    setChecking(true);
    setNote(null);
    try {
      const found = await findByKey(fetchPage, op);
      if (found) onFound(found);
      else if (op.restored && provenNotRecorded(op)) {
        setNotRecorded(true);
        setNote({ tone: 'warn', text: 'It was not recorded: it is not in the records, and it was sent long enough ago that it can no longer be. You can make the request again.' });
      } else if (op.restored) {
        setNote({ tone: 'warn', text: 'Not found yet. It may still be finishing; check again in a few minutes before making it again.' });
      } else setNote({ tone: 'warn', text: 'Not found in the recent records. That does not prove it was not recorded: it may still be finishing. Send the same request again; if it was not recorded it will be now, and if it was you get its record.' });
    } catch (err) {
      setNote({ tone: 'error', text: `Could not check the records: ${messageOf(err)}` });
    } finally {
      setChecking(false);
    }
  }

  if (op.restored) {
    return (
      <div className="confirm" role="group" aria-label={label}>
        <Alert tone="warn">
          A request made before this page was reloaded has not been confirmed yet. Its details are not kept on this device,
          so it cannot be sent again from here. Check whether it was recorded before making it again.
        </Alert>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <div className="confirm-actions">
          <Button busy={checking} onClick={() => void check()}>Check whether it was recorded</Button>
          {notRecorded && onDiscard && <Button variant="secondary" onClick={onDiscard}>Make the request again</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="confirm" role="group" aria-label={label}>
      <Alert tone="warn">
        {busy ? 'Sending… ' : ''}The outcome of this request is not known yet{op.error ? ` (${op.error})` : ''}. It may already be
        recorded. Sending the same request again is safe: it is never recorded twice. If it keeps being refused, ask an admin.
      </Alert>
      {summary}
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <div className="confirm-actions">
        <Button busy={busy} disabled={checking} onClick={onResend}>Send the same request again</Button>
        <Button variant="secondary" busy={checking} disabled={busy} onClick={() => void check()}>Check whether it was recorded</Button>
      </div>
    </div>
  );
}
