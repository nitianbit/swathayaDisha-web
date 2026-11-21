import { useEffect, useRef } from 'react';

/** What can take keyboard focus inside a panel, in document order. */
const CONTROLS = [
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', 'textarea:not([disabled])', 'button:not([disabled])', 'a[href]',
].join(', ');

/** The first control inside `el` (or null). */
export const firstControl = (el: HTMLElement | null) => el?.querySelector<HTMLElement>(CONTROLS) ?? null;

/** A field that takes typing or a choice; Enter on it never carries out the panel's step. */
const FIELD = 'input:not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]), select, textarea';
/** The panel's way back (`data-focus-back` on its Back button). */
const BACK = 'button[data-focus-back]:not([disabled])';

/**
 * WQ11d: where keyboard focus goes in `el` now. A panel whose first control is a field (a reason, a time to choose)
 * focuses that field; otherwise its Back button, else the panel itself (made focusable): never its action button, so
 * pressing Enter twice cannot carry out an irreversible step. Without a panel (closed), the first control: the trigger.
 */
export function focusTarget(el: HTMLElement | null): HTMLElement | null {
  const first = firstControl(el);
  if (!el || !first) return first;
  if (first.matches(FIELD)) return first;
  const back = el.querySelector<HTMLElement>(BACK);
  if (back) return back;
  const panel = el.querySelector<HTMLElement>('[role="group"], form');
  if (panel) {
    if (!panel.hasAttribute('tabindex')) panel.tabIndex = -1;
    return panel;
  }
  return first;
}

/** Focus may be moved when nothing holds it (the page body) or it is inside `host` (it was on a control that is now gone). */
function focusIsLost(host: HTMLElement) {
  const a = document.activeElement;
  return !a || a === document.body || host.contains(a);
}

/**
 * WQ11b (accessibility): an inline panel that replaces its trigger (a confirmation, a picker, a small form). Whenever
 * `phase` changes — the panel opens, moves to its next step, or closes — keyboard focus goes into what is now shown
 * inside the host (`focusTarget`): the panel's first field, else its Back button (WQ11d: never the action), and the
 * trigger again when it closes (Back, or done). Only when focus would otherwise be lost (on the page body because the focused control was unmounted, or still
 * inside this host), so it never takes focus away from somewhere else on the page.
 *
 * Put the returned ref on an element that wraps both the trigger and the panel (`display: contents` keeps the layout).
 */
export function usePanelFocus<T extends HTMLElement = HTMLElement>(phase: string) {
  const host = useRef<T | null>(null);
  const last = useRef(phase);
  useEffect(() => {
    if (last.current === phase) return;
    last.current = phase;
    const el = host.current;
    if (!el || !focusIsLost(el)) return;
    focusTarget(el)?.focus();
  }, [phase]);
  return host;
}

/** The wrapper's style: no box of its own, so flex and grid layouts around it are unchanged. */
export const FOCUS_HOST_STYLE = { display: 'contents' } as const;
