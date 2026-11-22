import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, assistedRefusal, pharmacyWalletApi, type ApiClient, type TopupOrder } from '@jansetu/api';
import { Alert, Button, formatDateTime, formatRupees, TextField } from '@jansetu/ui';
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

type CheckoutResult = { kind: 'paid'; razorpayPaymentId: string; razorpayOrderId: string; razorpaySignature: string } | { kind: 'closed' };

async function checkout(order: TopupOrder): Promise<CheckoutResult> {
  const Razorpay = await loadCheckout();
  return new Promise<CheckoutResult>((resolve) => {
    const rz = new Razorpay({
      key: order.razorpayKeyId,
      order_id: order.razorpayOrderId,
      amount: Math.round(order.amount * 100),
      currency: order.currency,
      name: 'Jansetu',
      description: 'Jansetu wallet top-up',
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

/** Asks the server to check one top-up with Razorpay (credited once if it was paid). Never throws. */
export async function checkTopup(api: ApiClient, paymentTransactionId: string): Promise<TopupOutcome> {
  try {
    const r = await pharmacyWalletApi(api).checkTopup(paymentTransactionId);
    return r.state === 'credited' ? { kind: 'credited' } : { kind: 'unpaid' };
  } catch (err) {
    if (err instanceof ApiError && ['PAYMENT_FAILED', 'PAYMENT_REFUNDED', 'PAYMENT_RECORD_NOT_FOUND', 'TOPUP_BLOCKED'].includes(err.code ?? '')) {
      return { kind: 'closed', message: assistedRefusal(err).message };
    }
    return { kind: 'unknown', message: assistedRefusal(err).message };
  }
}

/** Pays one opened top-up and settles it with the server: verify first, then the server-side check. Never throws. */
async function payTopup(api: ApiClient, order: TopupOrder): Promise<TopupOutcome> {
  let result: CheckoutResult;
  try {
    result = await checkout(order);
  } catch (err) {
    return { kind: 'unknown', message: err instanceof Error ? err.message : 'Could not open the payment page.' };
  }
  if (result.kind === 'paid') {
    try {
      const v = await pharmacyWalletApi(api).verify({ paymentTransactionId: order.paymentTransactionId, razorpayOrderId: result.razorpayOrderId,
        razorpayPaymentId: result.razorpayPaymentId, razorpaySignature: result.razorpaySignature });
      if (v.paymentRecord?.status === 'paid') return { kind: 'credited' };
    } catch { /* fall through to the server-side check */ }
  }
  return checkTopup(api, order.paymentTransactionId);
}

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
export function topupProblem(text: string): string | null {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text.trim())) return 'Enter the amount in rupees, for example 500.';
  const n = Number(text.trim());
  if (n < MIN_TOPUP) return `The smallest top-up is ${formatRupees(MIN_TOPUP)}.`;
  if (n > MAX_TOPUP) return `The largest top-up at one time is ${formatRupees(MAX_TOPUP)}.`;
  return null;
}

/**
 * Add money to the wallet by card or UPI. Opening an order moves no money (an unpaid Razorpay order is never charged),
 * so a failed start is simply tried again; the payment itself is settled once on the server (verify, else check).
 */
export function TopUpForm({ pharmacyId, suggested, onCredited }: { pharmacyId: string; suggested?: number; onCredited?: () => void }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const pending = usePendingTopups(pharmacyId);
  const { perform, busy } = useOneAtATime('wallet');
  const [amount, setAmount] = useState(suggested ? String(Math.ceil(suggested)) : '');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function start(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    const problem = topupProblem(amount);
    setError(problem);
    if (problem) return;
    const rupees = Number(amount.trim());
    try {
      await perform(async () => {
        let order: TopupOrder;
        try {
          order = await pharmacyWalletApi(api).startTopup(rupees);
        } catch (err) {
          if (live.current) setNote({ tone: 'error', text: `Could not start the top-up: ${assistedRefusal(err).message} No money was taken.` });
          return;
        }
        // Remembered BEFORE the payment page opens, so a closed tab or lost answer can still be checked.
        pending.add(order.paymentTransactionId, rupees);
        const outcome = await payTopup(api, order);
        void queryClient.invalidateQueries({ queryKey: ['pharmacy-wallet', pharmacyId] });
        if (outcome.kind === 'credited' || outcome.kind === 'closed') pending.remove(order.paymentTransactionId);
        if (!live.current) return;
        if (outcome.kind === 'credited') {
          setAmount('');
          setNote({ tone: 'ok', text: `${formatRupees(rupees)} was added to your wallet.` });
          onCredited?.();
        } else if (outcome.kind === 'closed') setNote({ tone: 'error', text: outcome.message });
        else if (outcome.kind === 'unpaid') {
          setNote({ tone: 'warn', text: 'The payment was not completed, so no money was added. If you did pay, tap “Check my top-up” below in a minute.' });
        } else {
          setNote({ tone: 'warn', text: `We could not confirm the top-up yet (${outcome.message}) If you paid, your money is safe: tap “Check my top-up” below in a minute.` });
        }
      });
    } catch (err) {
      if (live.current) setNote({ tone: 'error', text: assistedRefusal(err).message });
    }
  }

  return (
    <form className="rx-form" noValidate onSubmit={(e) => void start(e)} aria-label="Top up the wallet">
      <div className="ws-search">
        <TextField label="Amount to add (₹)" inputMode="decimal" value={amount} error={error} disabled={busy}
          hint="Paid by card or UPI on the Razorpay page." onChange={(e) => setAmount(e.target.value)} />
        <Button type="submit" busy={busy}>Top up</Button>
      </div>
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <PendingTopups pharmacyId={pharmacyId} pending={pending} />
    </form>
  );
}

/** Top-ups started on this device and not confirmed yet, each with "Check my top-up". */
function PendingTopups({ pharmacyId, pending }: { pharmacyId: string; pending: ReturnType<typeof usePendingTopups> }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const { perform, busy } = useOneAtATime('top-up check');
  const [checking, setChecking] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { tone: 'ok' | 'warn' | 'error'; text: string }>>({});
  if (pending.ids.length === 0 && Object.keys(notes).length === 0) return null;

  async function check(id: string) {
    setChecking(id);
    try {
      await perform(async () => {
        const outcome = await checkTopup(api, id);
        void queryClient.invalidateQueries({ queryKey: ['pharmacy-wallet', pharmacyId] });
        const amount = pending.info(id)?.amount;
        if (outcome.kind === 'credited' || outcome.kind === 'closed') pending.remove(id);
        setNotes((n) => ({ ...n, [id]: outcome.kind === 'credited' ? { tone: 'ok', text: `${amount ? formatRupees(amount) : 'The top-up'} was added to your wallet.` }
          : outcome.kind === 'closed' ? { tone: 'error', text: outcome.message }
          : outcome.kind === 'unpaid' ? { tone: 'warn', text: 'Not paid yet. If you paid, wait a minute and check again.' }
          : { tone: 'warn', text: `Could not check just now: ${outcome.message}` } }));
      });
    } catch (err) {
      setNotes((n) => ({ ...n, [id]: { tone: 'error', text: assistedRefusal(err).message } }));
    } finally {
      setChecking(null);
    }
  }

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
              <Button variant="secondary" busy={checking === id} disabled={busy && checking !== id} onClick={() => void check(id)}>Check my top-up</Button>
              {notes[id] && <Alert tone={notes[id].tone}>{notes[id].text}</Alert>}
            </li>
          );
        })}
        {done.map((id) => <li key={id}><Alert tone={notes[id]!.tone}>{notes[id]!.text}</Alert></li>)}
      </ul>
    </section>
  );
}
