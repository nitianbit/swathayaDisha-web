import { useState, type ReactNode } from 'react';
import { Alert, Button } from '@jansetu/ui';
import { ConfirmAction } from './ConfirmAction.tsx';
import type { Page } from '@jansetu/api';
import { messageOf } from '../errors.ts';
import { t } from '../i18n/components/index.ts';
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
  /**
   * WQ2 (bills, Q10): also offer `abandon` for a request still held on this device, once a check found nothing. Safe
   * whenever the server fences it (an abandoned key can never be recorded afterwards; a used one returns its record).
   */
  abandonWhenNotFound?: boolean;
  /** The words on the abandon button (default "Cancel it and start again"). */
  abandonLabel?: string;
}

/**
 * A submission whose outcome is not known. It can only be resent unchanged (safe: the server answers a repeated key
 * with the first record) or looked up in the records to show its receipt. Nothing here concludes "not recorded".
 * Render with `key={op.attempts}` so a lookup result never outlives a later attempt.
 */
export function PendingOpPanel<B, R extends { requestKey?: string; createdAt?: string }>(
  { label, op, summary, busy, onResend, fetchPage, onFound, onDiscard, abandon, forget, abandonWhenNotFound, abandonLabel = t('pending.abandon') }: Props<B, R>,
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
      setNote({ tone: 'error', text: t('pending.recordedNotShown') });
      setNotFound(false);
    } catch (err) {
      setNote({ tone: 'error', text: t('pending.abandonFailed', { reason: messageOf(err) }) });
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
          ? t('pending.restoredNotFound.cancelFirst')
          : t('pending.restoredNotFound.unknown') });
      } else {
        setNotFound(true);
        setNote({ tone: 'warn', text: abandon && abandonWhenNotFound
          ? t('pending.notFound.giveUp')
          : t('pending.notFound.resend') });
      }
    } catch (err) {
      setNote({ tone: 'error', text: t('pending.checkFailed', { reason: messageOf(err) }) });
    } finally {
      setChecking(false);
    }
  }

  if (op.restored) {
    return (
      <div className="confirm" role="group" aria-label={label}>
        <Alert tone="warn">{t('pending.restored')}</Alert>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <div className="confirm-actions">
          <Button busy={checking} disabled={abandoning} onClick={() => void check()}>{t('pending.check')}</Button>
          {notFound && abandon && <Button variant="secondary" busy={abandoning} disabled={checking} onClick={() => void cancelIt()}>{abandonLabel}</Button>}
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
        {busy ? `${t('pending.sending')} ` : ''}{op.error ? t('pending.unknownWithError', { error: op.error }) : t('pending.unknown')}
      </Alert>
      {summary}
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <div className="confirm-actions">
        <Button busy={busy} disabled={checking} onClick={onResend}>{t('pending.resend')}</Button>
        <Button variant="secondary" busy={checking} disabled={busy} onClick={() => void check()}>{t('pending.check')}</Button>
        {notFound && !busy && abandon && abandonWhenNotFound && (
          <Button variant="secondary" busy={abandoning} disabled={checking} onClick={() => void cancelIt()}>{abandonLabel}</Button>
        )}
        {notFound && !busy && !abandon && forget && (
          <ConfirmAction label={forget.label} danger confirmLabel={forget.confirmLabel} consequence={forget.consequence}
            onConfirm={async () => forget.onForget()} />
        )}
      </div>
    </div>
  );
}
