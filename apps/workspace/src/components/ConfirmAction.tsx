import { useRef, useState, type ReactNode } from 'react';
import { Alert, Button, TextArea } from '@jansetu/ui';
import { messageOf } from '../errors.ts';
import { FOCUS_HOST_STYLE, usePanelFocus } from './focus.ts';

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
  /**
   * WQ11b: the version of the record the step is about (e.g. its `updatedAt`). The confirmation remembers the version
   * it was opened on and passes it to `onConfirm`, so the step is sent on what the person reviewed; if the record moves
   * while it is open (and nothing is being sent), it closes and says so instead of confirming something unseen.
   */
  version?: string | number;
  /** `openedOn`: the `version` this confirmation was opened on (undefined when no version is given). */
  onConfirm: (reason: string, openedOn?: string | number) => Promise<unknown>;
}

export const CHANGED_WHILE_OPEN = 'This changed while the confirmation was open, so nothing was done. Check what is shown now and try again.';

/**
 * Two-step action: the first click explains the consequence (and asks for a reason), the second performs it. Used for
 * anything that cannot be undone from the workspace.
 *
 * WQ11b: a confirmation belongs to one step. When its step changes under it (another `label`/`confirmLabel`, e.g. a
 * Deactivate that becomes Activate after the record was read again, or another `version`) it closes; the refusal it was
 * showing, or the late answer of the step sent before, is shown next to the trigger with the step's name, never inside
 * another step's confirmation. Keyboard focus moves to the first control when it opens and back to the trigger when it
 * closes.
 */
export function ConfirmAction({
  label, consequence, confirmLabel, reason = false, reasonLabel = 'Reason', maxReason = 500, danger = false, disabled, version,
  onConfirm,
}: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Shown next to the trigger: why an open confirmation was closed, or the answer of a step whose confirmation is gone. */
  const [note, setNote] = useState<string | null>(null);
  const [openedOn, setOpenedOn] = useState<string | number | undefined>(undefined);
  /** Bumped whenever the confirmation closes: an answer of an older opening changes nothing in a newer one. */
  const generation = useRef(0);
  const identity = `${label}\u0000${confirmLabel}`;
  const [shownFor, setShownFor] = useState({ identity, confirmLabel });
  const host = usePanelFocus<HTMLSpanElement>(open ? 'open' : 'closed');

  const reset = () => { generation.current += 1; setOpen(false); setText(''); setError(null); setFieldError(null); };
  // Derived during render, so the old step's panel is never shown with the new step's words.
  if (shownFor.identity !== identity) {
    setShownFor({ identity, confirmLabel });
    if (open) {
      reset();
      setNote(error ? `${shownFor.confirmLabel}: ${error}` : null);
    }
  } else if (open && !busy && version !== undefined && openedOn !== version) {
    reset();
    setNote(error ? `${confirmLabel}: ${error}` : CHANGED_WHILE_OPEN);
  }

  async function confirm() {
    const value = text.trim();
    if (reason === true && value.length < 3) { setFieldError('Give a reason (at least 3 characters).'); return; }
    const mine = generation.current;
    const step = confirmLabel;
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      await onConfirm(value, openedOn);
      if (generation.current === mine) reset();
    } catch (err) {
      if (generation.current === mine) setError(messageOf(err));
      else setNote(`${step}: ${messageOf(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span ref={host} style={FOCUS_HOST_STYLE}>
      {!open ? (
        <>
          {note && <Alert tone="warn">{note}</Alert>}
          <Button variant={danger ? 'secondary' : 'primary'} disabled={disabled}
            onClick={() => { setNote(null); setOpenedOn(version); setOpen(true); }}>{label}</Button>
        </>
      ) : (
        <div className="confirm" role="group" aria-label={label}>
          <div className="confirm-text">{consequence}</div>
          {reason && (
            <TextArea label={reason === 'optional' ? `${reasonLabel} (optional)` : reasonLabel} value={text} maxLength={maxReason}
              onChange={(e) => setText(e.target.value)} error={fieldError} />
          )}
          {error && <Alert>{error}</Alert>}
          <div className="confirm-actions">
            {/* A step that started after this was opened blocks it too (screens with one-step-at-a-time guards refuse it anyway). */}
            <Button variant={danger ? 'danger' : 'primary'} busy={busy} disabled={disabled && !busy} onClick={() => void confirm()}>{confirmLabel}</Button>
            <Button variant="ghost" disabled={busy} onClick={reset}>Back</Button>
          </div>
        </div>
      )}
    </span>
  );
}
