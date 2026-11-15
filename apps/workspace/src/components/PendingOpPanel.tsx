import { useState, type ReactNode } from 'react';
import { Alert, Button } from '@jansetu/ui';
import { ConfirmAction } from './ConfirmAction.tsx';
import type { Page } from '@jansetu/api';
import { messageOf } from '../errors.ts';
import { findByKey, type PendingOp } from '../requests.ts';

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
  /** D4: forget a restored request after the server abandoned its key (then a new one can be made). */
  onDiscard?: () => void;
  /** D4: abandon the restored request's key on the server: 'abandoned' = it can never be recorded; 'used' = it was
   * (then the server returns its exact record). */
  abandon?: () => Promise<{ state: 'abandoned' | 'used'; record?: R }>;
  /**
   * WQ2: for requests the server cannot abandon (no request-key kind for them): after a check found nothing, the person
   * may decide to forget it, after a second step that says what that risks (a duplicate they then have to undo).
   */
  forget?: { label: string; confirmLabel: string; consequence: ReactNode; onForget: () => void };
}

/**
 * A submission whose outcome is not known. It can only be resent unchanged (safe: the server answers a repeated key
 * with the first record) or looked up in the records to show its receipt. Nothing here concludes "not recorded".
 * Render with `key={op.attempts}` so a lookup result never outlives a later attempt.
 */
export function PendingOpPanel<B, R extends { requestKey?: string; createdAt?: string }>(
  { label, op, summary, busy, onResend, fetchPage, onFound, onDiscard, abandon, forget }: Props<B, R>,
) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [abandoning, setAbandoning] = useState(false);

  async function cancelIt() {
    if (!abandon) return;
    setAbandoning(true);
    setNote(null);
    try {
      const r = await abandon();
      if (r.state === 'abandoned') { onDiscard?.(); return; }
      // The server says it WAS recorded and returns that exact record.
      if (r.record) { onFound(r.record); return; }
      setNote({ tone: 'error', text: 'It was recorded, but its record could not be shown. Reload the page.' });
      setNotFound(false);
    } catch (err) {
      setNote({ tone: 'error', text: `Could not cancel it: ${messageOf(err)}` });
    } finally {
      setAbandoning(false);
    }
  }

  async function check() {
    setChecking(true);
    setNote(null);
    try {
      const found = await findByKey(fetchPage, op);
      if (found) onFound(found);
      else if (op.restored) {
        setNotFound(true);
        setNote({ tone: 'warn', text: abandon || !forget
          ? 'Not found in the records. It may still be on its way. To make the request again, first cancel this one: once cancelled it can never be recorded.'
          : 'Not found in the records. It may still be on its way, or it was never recorded: this cannot be told apart from here.' });
      } else {
        setNotFound(true);
        setNote({ tone: 'warn', text: 'Not found in the recent records. That does not prove it was not recorded: it may still be finishing. Send the same request again; if it was not recorded it will be now, and if it was you get its record.' });
      }
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
          A request made earlier on this device (before the page was reloaded, or before you signed out) has not been
          confirmed yet. Its details are not kept, so it cannot be sent again from here. Check whether it was recorded
          before making it again.
        </Alert>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <div className="confirm-actions">
          <Button busy={checking} disabled={abandoning} onClick={() => void check()}>Check whether it was recorded</Button>
          {notFound && abandon && <Button variant="secondary" busy={abandoning} disabled={checking} onClick={() => void cancelIt()}>Cancel it and start again</Button>}
          {notFound && !abandon && forget && (
            <ConfirmAction label={forget.label} danger confirmLabel={forget.confirmLabel} consequence={forget.consequence}
              onConfirm={async () => forget.onForget()} />
          )}
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
        {notFound && !busy && !abandon && forget && (
          <ConfirmAction label={forget.label} danger confirmLabel={forget.confirmLabel} consequence={forget.consequence}
            onConfirm={async () => forget.onForget()} />
        )}
      </div>
    </div>
  );
}
