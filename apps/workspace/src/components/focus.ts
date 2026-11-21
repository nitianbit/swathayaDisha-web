import { useEffect, useRef } from 'react';

/** What can take keyboard focus inside a panel, in document order. */
const CONTROLS = [
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', 'textarea:not([disabled])', 'button:not([disabled])', 'a[href]',
].join(', ');

/** The first control inside `el` (or null). */
export const firstControl = (el: HTMLElement | null) => el?.querySelector<HTMLElement>(CONTROLS) ?? null;

/** Focus may be moved when nothing holds it (the page body) or it is inside `host` (it was on a control that is now gone). */
function focusIsLost(host: HTMLElement) {
  const a = document.activeElement;
  return !a || a === document.body || host.contains(a);
}

/**
 * WQ11b (accessibility): an inline panel that replaces its trigger (a confirmation, a picker, a small form). Whenever
 * `phase` changes — the panel opens, moves to its next step, or closes — keyboard focus goes to the first control now
 * shown inside the host: the panel's first field or button when it opens, the trigger again when it closes (Back, or
 * done). Only when focus would otherwise be lost (on the page body because the focused control was unmounted, or still
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
    firstControl(el)?.focus();
  }, [phase]);
  return host;
}

/** The wrapper's style: no box of its own, so flex and grid layouts around it are unchanged. */
export const FOCUS_HOST_STYLE = { display: 'contents' } as const;
