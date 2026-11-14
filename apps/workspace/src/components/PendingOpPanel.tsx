import { useState, type ReactNode } from 'react';
import { Alert, Button } from '@jansetu/ui';
import { messageOf } from '../errors.ts';
import { findByKey, SETTLE_MS, type KeySearch, type PendingOp } from '../requests.ts';
import type { Page } from '@jansetu/api';

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
  onDiscard: () => void;
}

/**
 * A submission whose outcome is unknown. Staff can resend it unchanged, or check the server's records for its key.
 * It can be discarded only when the records were searched and the key is absent long after the last attempt.
 */
export function PendingOpPanel<B, R extends { requestKey?: string; createdAt?: string }>(
  { label, op, summary, busy, onResend, fetchPage, onFound, onDiscard }: Props<B, R>,
) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<KeySearch<R> | { error: string } | null>(null);

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      const r = await findByKey(fetchPage, op);
      if (r.found) onFound(r.found); else setResult(r);
    } catch (err) {
      setResult({ error: messageOf(err) });
    } finally {
      setChecking(false);
    }
  }

  const waitMin = Math.max(1, Math.ceil((op.lastAttemptAt + SETTLE_MS - Date.now()) / 60_000));
  return (
    <div className="confirm" role="group" aria-label={label}>
      <Alert tone="warn">
        This was sent but its outcome is not known{op.error ? ` (${op.error})` : ''}. It may already be recorded. Send the
        same request again, or check the records; it will not be recorded twice.
      </Alert>
      {summary}
      {result && 'error' in result && <Alert>Could not check the records: {result.error}</Alert>}
      {result && 'incomplete' in result && <Alert tone="warn">The records are too long to search here; ask an admin to check.</Alert>}
      {result && 'settled' in result && !result.settled && (
        <Alert tone="warn">Not in the records yet. It could still be finishing; check again in {waitMin} minute{waitMin === 1 ? '' : 's'}.</Alert>
      )}
      {result && 'settled' in result && result.settled && (
        <Alert tone="ok">It is not in the records, and enough time has passed: it was not recorded. You can discard it and start again.</Alert>
      )}
      <div className="confirm-actions">
        <Button busy={busy} disabled={checking} onClick={onResend}>Send the same request again</Button>
        <Button variant="secondary" busy={checking} disabled={busy} onClick={() => void check()}>Check whether it was recorded</Button>
        {result && 'settled' in result && result.settled && (
          <Button variant="ghost" disabled={busy} onClick={onDiscard}>Discard it</Button>
        )}
      </div>
    </div>
  );
}
