import { useState, type ReactNode } from 'react';
import { Alert, Button, TextArea } from '@jansetu/ui';
import { messageOf } from '../errors.ts';

interface Props {
  /** Button that opens the confirmation. */
  label: string;
  /** What will happen, in plain words; shown before the user confirms. */
  consequence: ReactNode;
  confirmLabel: string;
  /** Ask for a reason (min 3 chars, max `maxReason`) when true; optional text when 'optional'. */
  reason?: boolean | 'optional';
  reasonLabel?: string;
  maxReason?: number;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}

/**
 * Two-step action: the first click explains the consequence (and asks for a reason), the second performs it. Used for
 * anything that cannot be undone from the workspace.
 */
export function ConfirmAction({
  label, consequence, confirmLabel, reason = false, reasonLabel = 'Reason', maxReason = 500, danger = false, disabled,
  onConfirm,
}: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return <Button variant={danger ? 'secondary' : 'primary'} disabled={disabled} onClick={() => setOpen(true)}>{label}</Button>;
  }

  async function confirm() {
    const value = text.trim();
    if (reason === true && value.length < 3) { setFieldError('Give a reason (at least 3 characters).'); return; }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      await onConfirm(value);
      setOpen(false);
      setText('');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="confirm" role="group" aria-label={label}>
      <div className="confirm-text">{consequence}</div>
      {reason && (
        <TextArea label={reason === 'optional' ? `${reasonLabel} (optional)` : reasonLabel} value={text} maxLength={maxReason}
          onChange={(e) => setText(e.target.value)} error={fieldError} />
      )}
      {error && <Alert>{error}</Alert>}
      <div className="confirm-actions">
        <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={() => void confirm()}>{confirmLabel}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setOpen(false); setError(null); setFieldError(null); }}>
          Back
        </Button>
      </div>
    </div>
  );
}
