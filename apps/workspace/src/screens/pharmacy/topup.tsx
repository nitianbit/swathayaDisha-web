import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, assistedRefusal, pharmacyWalletApi, type ApiClient, type Refusal, type TopupCheck, type TopupOrder } from '@jansetu/api';
import { Alert, Button, formatDateTime, formatRupees, TextField } from '@jansetu/ui';
import { newRequestKey, startOp } from '../../requests.ts';
import { useOwnedOp } from './ownedOp.tsx';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';

/**
 * WQ12: wallet top-ups by Razorpay, the customer app's checkout pattern (`apps/customer/src/payments.ts`): the server
 * opens the order (`POST /pharmacy-wallet/topup`), Checkout takes the payment, the browser's proof goes to
 * `/payments/verify` (S6: no `module`), and when that proof is missing or fails the server asks Razorpay itself
 * (`POST /pharmacy-wallet/topups/:id/check`). A captured payment is credited exactly once whichever path gets there.
 *
 * Unfinished top-ups are remembered on this device by their payment record id only (no amounts, names or tokens), so
 * "Check my top-up" still works after a reload.
 */

interface RazorpayInstance { open(): void; on(event: 'payment.failed', cb: (r: unknown) => void): void }
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;
declare global { interface Window { Razorpay?: RazorpayCtor } }

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let loading: Promise<RazorpayCtor> | null = null;

function loadCheckout(): Promise<RazorpayCtor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  loading ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CHECKOUT_SRC;
    s.async = true;
    s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('The payment page did not load.')));
    s.onerror = () => { loading = null; reject(new Error('Could not open the payment page. Check your connection and try again.')); };
    document.head.appendChild(s);
  });
  return loading;
}

export type CheckoutResult = { kind: 'paid'; razorpayPaymentId: string; razorpayOrderId: string; razorpaySignature: string } | { kind: 'closed' };
/** What Checkout needs: the server's order (WQ16: also a card booking's, with `amountMinor` from its answer). */
export interface CheckoutOrder {
  /** WQ17c: absent when only the order is known (Checkout then takes the order's own amount). */
  razorpayKeyId: string; razorpayOrderId: string; amountMinor?: number; currency: string; description: string;
  /** WQ16c: Razorpay's `timeout` (seconds): the page closes itself (as if dismissed) before the booking's cut-off. */
  timeoutSeconds?: number;
}

/** Opens Razorpay Checkout on one order. Rejects only when the Checkout script cannot load (nothing was opened). */
export async function openCheckout(order: CheckoutOrder): Promise<CheckoutResult> {
  const Razorpay = await loadCheckout();
  return new Promise<CheckoutResult>((resolve) => {
    const rz = new Razorpay({
      key: order.razorpayKeyId,
      order_id: order.razorpayOrderId,
      ...(order.amountMinor !== undefined ? { amount: order.amountMinor } : {}),
      currency: order.currency,
      name: 'Jansetu',
      description: order.description,
      ...(order.timeoutSeconds !== undefined ? { timeout: order.timeoutSeconds } : {}),
      theme: { color: '#0b6e70' },
      handler: (r: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) =>
        resolve({ kind: 'paid', razorpayPaymentId: r.razorpay_payment_id, razorpayOrderId: r.razorpay_order_id, razorpaySignature: r.razorpay_signature }),
      modal: { ondismiss: () => resolve({ kind: 'closed' }) },
    });
    // A failed attempt keeps Checkout open for another try; the outcome arrives through handler or ondismiss.
    rz.on('payment.failed', () => undefined);
    rz.open();
  });
}

export type TopupOutcome =
  | { kind: 'credited' }
  | { kind: 'unpaid' }
  /** The payment is over without money added (failed, refunded, blocked, not found): stop tracking it. */
  | { kind: 'closed'; message: string }
  /** No answer from the server: keep it and check again later. */
  | { kind: 'unknown'; message: string };

/**
 * WQ20: whose wallet a top-up goes to, and through which routes: the pharmacy's (`/pharmacy-wallet`, no request key) or
 * a lab's (`/partner-workspace/assisted/wallet/topups`, keyed; §24.13). The same form, payment and check serve both.
 */
export interface TopupSource {
  /** The owner's id, for this device's memory slots. */
  owner: string;
  /** The wallet's query key (read again after every answer). */
  queryKey: readonly unknown[];
  /** The largest top-up at one time (rupees). */
  maxRupees: number;
  /** Opens the Razorpay order; `requestKey` is new for each top-up (a keyed create answers a resend with the same order). */
  start: (rupees: number, requestKey: string) => Promise<TopupOrder>;
  verify: (p: { paymentTransactionId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) =>
    Promise<{ paymentRecord: { status: string; credited?: boolean } }>;
  check: (paymentTransactionId: string) => Promise<TopupCheck>;
  refusal: (err: unknown) => Refusal;
  /** Remember unfinished top-ups on this device (the lab's own top-ups are listed by the server instead). */
  rememberOnDevice: boolean;
  /**
   * WQ20b: the order is keyed (the lab's): an order whose answer was lost is asked for again with the SAME key and amount
   * (an owned request), so a repeated "Top up" never makes a second unpaid order (which would count towards the limit).
   */
  keyed: boolean;
}

/** The pharmacy's own top-ups (WQ12). */
export function pharmacyTopupSource(api: ApiClient, pharmacyId: string): TopupSource {
  const w = pharmacyWalletApi(api);
  return { owner: pharmacyId, queryKey: ['pharmacy-wallet', pharmacyId], maxRupees: MAX_TOPUP, start: (rupees) => w.startTopup(rupees),
    verify: (p) => w.verify(p), check: (id) => w.checkTopup(id), refusal: assistedRefusal, rememberOnDevice: true, keyed: false };
}

/** Asks the server to check one top-up with Razorpay (credited once if it was paid). Never throws. */
export async function checkTopup(source: TopupSource, paymentTransactionId: string): Promise<TopupOutcome> {
  try {
    const r = await source.check(paymentTransactionId);
    return r.state === 'credited' ? { kind: 'credited' } : { kind: 'unpaid' };
  } catch (err) {
    if (err instanceof ApiError && ['PAYMENT_FAILED', 'PAYMENT_REFUNDED', 'PAYMENT_RECORD_NOT_FOUND', 'TOPUP_BLOCKED'].includes(err.code ?? '')) {
      return { kind: 'closed', message: source.refusal(err).message };
    }
    return { kind: 'unknown', message: source.refusal(err).message };
  }
}

/** Pays one opened top-up and settles it with the server: verify first, then the server-side check. Never throws. */
async function payTopup(source: TopupSource, order: TopupOrder): Promise<TopupOutcome> {
  let result: CheckoutResult;
  try {
    result = await openCheckout({ razorpayKeyId: order.razorpayKeyId, razorpayOrderId: order.razorpayOrderId, amountMinor: Math.round(order.amount * 100),
      currency: order.currency, description: 'Jansetu wallet top-up' });
  } catch {
    // The Checkout script did not load, so the payment page never opened: nothing can have been paid on it.
    return { kind: 'closed', message: NOT_OPENED };
  }
  if (result.kind === 'paid') {
    try {
      const v = await source.verify({ paymentTransactionId: order.paymentTransactionId, razorpayOrderId: result.razorpayOrderId,
        razorpayPaymentId: result.razorpayPaymentId, razorpaySignature: result.razorpaySignature });
      // WQ20b: paid AND credited (a lab's answer says `credited`; the pharmacy's has no such field): else the server's check.
      if (v.paymentRecord?.status === 'paid' && v.paymentRecord.credited !== false) return { kind: 'credited' };
    } catch { /* fall through to the server-side check */ }
  }
  return checkTopup(source, order.paymentTransactionId);
}

export const NOT_OPENED = 'The payment page didn’t open. No money was taken.';
export const UNPAID_CHECK_AGAIN = 'Not paid yet. If you paid, wait a minute and check again.';
export const UNPAID_WORDS = `${UNPAID_CHECK_AGAIN} If you did not pay, you can remove it from this list.`;
export const CHECK_LABEL = 'Check my top-up';
const pendingSlot = (pharmacyId: string) => `wallet-topups:${pharmacyId}`;
const infoSlot = (pharmacyId: string) => `wallet-topup-info:${pharmacyId}`;
type TopupInfo = Record<string, { amount: number; at: number }>;

/** The unfinished top-ups of this pharmacy on this device (ids kept across a reload; amounts only until then). */
export function usePendingTopups(pharmacyId: string) {
  const { memory } = useSession();
  const [ids, setIds] = useState<readonly string[]>(() => memory.get<string[]>(pendingSlot(pharmacyId)) ?? []);
  const info = () => memory.get<TopupInfo>(infoSlot(pharmacyId)) ?? {};
  const save = (next: string[]) => { memory.set(pendingSlot(pharmacyId), next); setIds(next); };
  return {
    ids,
    info: (id: string) => info()[id],
    add: (id: string, amount: number) => {
      memory.set(infoSlot(pharmacyId), { ...info(), [id]: { amount, at: Date.now() } });
      save([...new Set([id, ...(memory.get<string[]>(pendingSlot(pharmacyId)) ?? [])])]);
    },
    remove: (id: string) => save((memory.get<string[]>(pendingSlot(pharmacyId)) ?? []).filter((x) => x !== id)),
  };
}

export const MIN_TOPUP = 1;
export const MAX_TOPUP = 200_000;
export function topupProblem(text: string, max = MAX_TOPUP): string | null {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text.trim())) return 'Enter the amount in rupees, for example 500.';
  const n = Number(text.trim());
  if (n < MIN_TOPUP) return `The smallest top-up is ${formatRupees(MIN_TOPUP)}.`;
  if (n > max) return `The largest top-up at one time is ${formatRupees(max)}.`;
  return null;
}

/**
 * Add money to the wallet by card or UPI. Opening an order moves no money (an unpaid Razorpay order is never charged),
 * so a failed start is simply tried again; the payment itself is settled once on the server (verify, else check).
 */
export function TopUpForm({ pharmacyId, source: given, suggested, onCredited }: {
  pharmacyId: string; source?: TopupSource; suggested?: number; onCredited?: () => void;
}) {
  const { api } = useSession();
  const source = given ?? pharmacyTopupSource(api, pharmacyId);
  const queryClient = useQueryClient();
  const pending = usePendingTopups(source.owner);
  const { perform, busy } = useOneAtATime('wallet');
  // WQ20b: a keyed order whose answer was lost (the amount, and its key as the stored request's).
  const started = useOwnedOp<{ rupees: number }>(`topup-start:${source.owner}`);
  const unconfirmed = source.keyed && started.op?.body && !started.op.restored ? started.op : undefined;
  const [amount, setAmount] = useState(suggested ? String(Math.ceil(suggested)) : '');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function start(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    const problem = unconfirmed ? null : topupProblem(amount, source.maxRupees);
    setError(problem);
    if (problem) return;
    const rupees = unconfirmed ? unconfirmed.body.rupees : Number(amount.trim());
    try {
      await perform(async () => {
        let order: TopupOrder;
        if (source.keyed) {
          // The same request (key and amount) when the last one's answer was lost; else a new one, stored before it is sent.
          const p = unconfirmed ?? startOp(newRequestKey(), { rupees });
          const r = await started.send(p, (b) => source.start(b.rupees, p.requestKey));
          if (r.kind === 'stale') return;
          if (r.kind !== 'ok') {
            if (live.current) {
              setNote({ tone: 'error', text: r.kind === 'refused'
                ? `Could not start the top-up: ${source.refusal(r.error).message} No money was taken.`
                : `Could not start the top-up: ${source.refusal(r.error).message} No money was taken. “Top up” asks for the same ${formatRupees(rupees)} again (never a second order).` });
            }
            return;
          }
          order = r.value;
        } else {
          try {
            order = await source.start(rupees, newRequestKey());
          } catch (err) {
            if (live.current) setNote({ tone: 'error', text: `Could not start the top-up: ${source.refusal(err).message} No money was taken.` });
            return;
          }
        }
        // Remembered BEFORE the payment page opens, so a closed tab or lost answer can still be checked.
        if (source.rememberOnDevice) pending.add(order.paymentTransactionId, rupees);
        const outcome = await payTopup(source, order);
        void queryClient.invalidateQueries({ queryKey: source.queryKey });
        if (outcome.kind === 'credited' || outcome.kind === 'closed') pending.remove(order.paymentTransactionId);
        if (!live.current) return;
        if (outcome.kind === 'credited') {
          setAmount('');
          setNote({ tone: 'ok', text: `${formatRupees(rupees)} was added to your wallet.` });
          onCredited?.();
        } else if (outcome.kind === 'closed') setNote({ tone: outcome.message === NOT_OPENED ? 'warn' : 'error', text: outcome.message });
        else if (outcome.kind === 'unpaid') {
          setNote({ tone: 'warn', text: `The payment was not completed, so no money was added. If you did pay, tap “${CHECK_LABEL}” ${source.rememberOnDevice ? 'below' : 'next to it under Top-ups'} in a minute.` });
        } else {
          setNote({ tone: 'warn', text: `We could not confirm the top-up yet (${outcome.message}) If you paid, your money is safe: tap “${CHECK_LABEL}” ${source.rememberOnDevice ? 'below' : 'next to it under Top-ups'} in a minute.` });
        }
      });
    } catch (err) {
      if (live.current) setNote({ tone: 'error', text: source.refusal(err).message });
    }
  }

  return (
    <form className="rx-form" noValidate onSubmit={(e) => void start(e)} aria-label="Top up the wallet">
      <div className="ws-search">
        <TextField label="Amount to add (₹)" inputMode="decimal" value={unconfirmed ? String(unconfirmed.body.rupees) : amount} error={error} disabled={busy || !!unconfirmed}
          hint="Paid by card or UPI on the Razorpay page." onChange={(e) => setAmount(e.target.value)} />
        <Button type="submit" busy={busy}>Top up</Button>
        {unconfirmed && !busy && (
          <Button variant="ghost" onClick={() => started.settle(unconfirmed.requestKey)}>Use another amount</Button>
        )}
      </div>
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      {source.rememberOnDevice && <PendingTopups source={source} pending={pending} />}
    </form>
  );
}

type CheckNote = { tone: 'ok' | 'warn' | 'error'; text: string };

/**
 * WQ20b: "Check my top-up" on one top-up (the device's own list, and the lab's Top-ups): the server asks Razorpay, adds it
 * once if paid, and the answer is said next to it. `onSettled`: added, or over without money (failed, refunded, blocked).
 */
export function useTopupCheck(source: TopupSource, unpaidWords: string, onSettled?: (id: string) => void) {
  const queryClient = useQueryClient();
  const { perform, busy } = useOneAtATime('top-up check');
  const [checking, setChecking] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, CheckNote>>({});
  async function check(id: string, amountRupees: number | undefined) {
    setChecking(id);
    try {
      await perform(async () => {
        const outcome = await checkTopup(source, id);
        void queryClient.invalidateQueries({ queryKey: source.queryKey });
        if (outcome.kind === 'credited' || outcome.kind === 'closed') onSettled?.(id);
        setNotes((n) => ({ ...n, [id]: outcome.kind === 'credited' ? { tone: 'ok', text: `${amountRupees ? formatRupees(amountRupees) : 'The top-up'} was added to your wallet.` }
          : outcome.kind === 'closed' ? { tone: 'error', text: outcome.message }
          : outcome.kind === 'unpaid' ? { tone: 'warn', text: unpaidWords }
          : { tone: 'warn', text: `Could not check just now: ${outcome.message}` } }));
      });
    } catch (err) {
      setNotes((n) => ({ ...n, [id]: { tone: 'error', text: source.refusal(err).message } }));
    } finally {
      setChecking(null);
    }
  }
  const drop = (id: string) => setNotes((n) => { const { [id]: _gone, ...rest } = n; return rest; });
  return { busy, checking, notes, check, drop };
}

/** Top-ups started on this device and not confirmed yet, each with "Check my top-up". */
function PendingTopups({ source, pending }: { source: TopupSource; pending: ReturnType<typeof usePendingTopups> }) {
  const { busy, checking, notes, check, drop } = useTopupCheck(source, UNPAID_WORDS, (id) => pending.remove(id));
  if (pending.ids.length === 0 && Object.keys(notes).length === 0) return null;

  const done = Object.keys(notes).filter((id) => !pending.ids.includes(id));
  return (
    <section aria-labelledby="pending-topups-h">
      <h3 id="pending-topups-h">Top-ups not confirmed yet</h3>
      <ul className="ws-list">
        {pending.ids.map((id) => {
          const info = pending.info(id);
          return (
            <li key={id} className="ws-actions">
              <span>{info ? `${formatRupees(info.amount)}, started ${formatDateTime(new Date(info.at).toISOString())}` : 'A top-up started earlier on this device'}</span>
              <Button variant="secondary" busy={checking === id} disabled={busy && checking !== id} onClick={() => void check(id, info?.amount)}>{CHECK_LABEL}</Button>
              {notes[id] && <Alert tone={notes[id].tone}>{notes[id].text}</Alert>}
              {notes[id]?.text === UNPAID_WORDS && (
                // Not paid when checked: it may be dropped from this device. A payment captured later is still found and
                // credited by Jansetu's own payment check (the recovery sweep), so nothing is lost by removing it here.
                <Button variant="ghost" disabled={busy} onClick={() => { pending.remove(id); drop(id); }}>
                  Remove from this list
                </Button>
              )}
            </li>
          );
        })}
        {done.map((id) => <li key={id}><Alert tone={notes[id]!.tone}>{notes[id]!.text}</Alert></li>)}
      </ul>
    </section>
  );
}
