import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { refusedBeforeWriting, type Refusal } from '@jansetu/api';
import { newRequestKey, startOp, wasAbandoned, type PendingOp } from '../../requests.ts';
import type { Perform } from '../finance/finance.tsx';
import { useOwnedOp, type SendResult } from './ownedOp.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * What every assisted create keeps while one is checked and sent: the request (with its key, and for the pharmacy's
 * creates the price it accepts) and its summary. WQ19: the lab desk fences its own total and re-reads it instead.
 */
export interface PendingCreate {
  request: { requestKey: string; acceptedPriceMinor?: number };
  /** The pharmacy's creates show `priceMinor` (and `couponChecked` once a coupon was priced). */
  summary: object;
}

/**
 * WQ17b: the keyed create of an assisted booking (WQ12, moved here from Book consultation so that Book lab test sends,
 * refuses, re-prices and gives up the very same way). One owned request per screen slot: the review holds the key and the
 * body; paying sends exactly that; an unknown answer stays stored (`UnconfirmedBooking`); a refusal that recorded nothing
 * makes paying again a new request (a new key). The screen supplies the routes and what it does with each answer.
 */
export function useAssistedCreate<P extends PendingCreate, R, A extends { state: string }>(o: {
  slot: string;
  perform: Perform;
  book: (request: P['request']) => Promise<R>;
  abandon: (key: string) => Promise<A>;
  refusal: (err: unknown) => Refusal;
  /** The pharmacy's wallet (read again after a wallet refusal; WQ19: none for the lab desk) and the lists a booking changes. */
  walletKey?: readonly unknown[];
  /** WQ19: false when nothing is charged through Jansetu (the lab desk: paid at the lab). */
  charged?: boolean;
  refreshKeys: readonly (readonly unknown[])[];
  /** The create answered (also a replay). */
  onReceipt: (answer: R, p: PendingOp<P>) => void;
  /** A give-up found the key used: settle and show it; a sentence when something is still to do. */
  onUsed: (answer: A & { state: 'used' }, p: PendingOp<P>, restored: boolean) => string | null;
  onOff: () => void;
  onNotice: (words: string) => void;
  /** After every answer that is not stale. */
  onResult?: (r: SendResult<R>) => void;
  /** A sole first attempt refused before any write (switch, indexes, linking, limit, no gateway keys). */
  onRefusedBeforeWriting?: (why: Refusal, err: unknown) => void;
  /** A definite refusal: what the screen resets (its choices, its reads). */
  onRefused?: (why: Refusal, err: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const { op, send, settle } = useOwnedOp<P>(o.slot);
  const [review, setReview] = useState<({ requestKey: string } & P) | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [givingUp, setGivingUp] = useState(false);

  const refresh = () => { for (const queryKey of [...(o.walletKey ? [o.walletKey] : []), ...o.refreshKeys]) void queryClient.invalidateQueries({ queryKey }); };
  const nothing = o.charged === false ? 'nothing was booked' : 'nothing was booked or charged';

  /** The review stays, but paying again is a new request (a new key). */
  const rotateKey = () => {
    const requestKey = newRequestKey();
    setReview((v) => (v ? { ...v, requestKey, request: { ...v.request, requestKey } } : v));
  };

  /** Sends `p` (its key, its request) under the one-at-a-time guard; an unknown outcome stays stored for the panel. */
  async function sendCreate(p: PendingOp<P>) {
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await o.perform(() => send(p, (b) => o.book(b.request)));
    if (r.kind === 'stale') return;
    o.onResult?.(r);
    if (r.kind === 'ok') {
      setReview(null);
      o.onReceipt(r.value, p);
      refresh();
      return;
    }
    if (r.kind === 'unknown' && wasAbandoned(r.error)) {
      settle(p.requestKey);
      setReview(null);
      o.onNotice(t('assistedCreate.thisBookingWasGivenUp', { nothing }));
      return;
    }
    // A limit, the switch, the indexes or customer linking refused the only attempt before any booking write
    // (`refusedBeforeWriting`): nothing was booked. Paying again later is a new request.
    if (r.kind === 'unknown' && sole && refusedBeforeWriting(r.error)) {
      settle(p.requestKey);
      const why = o.refusal(r.error);
      if (why.kind === 'off') { o.onOff(); setReview(null); return; }
      o.onRefusedBeforeWriting?.(why, r.error);
      setRefused(why);
      rotateKey();
      return;
    }
    if (r.kind === 'refused') {
      const why = o.refusal(r.error);
      if (why.kind === 'off') { o.onOff(); setReview(null); return; }
      setRefused(why);
      o.onRefused?.(why, r.error);
      if (why.kind === 'patient' || why.kind === 'coupon' || why.kind === 'other' || why.kind === 'limit') setReview(null);
      // 'price', 'topup', 'wallet': the review stays, with what to do next; paying again is a new request (a new key).
      if (why.kind === 'topup' || why.kind === 'wallet') {
        if (o.walletKey) void queryClient.invalidateQueries({ queryKey: o.walletKey });
        rotateKey();
      }
    }
  }

  /** Sends the reviewed request (`shape` may set what the review's last choice changes, e.g. the way to pay). */
  async function pay(shape: (p: P) => P = (p) => p) {
    if (!review) return;
    const { requestKey, ...rest } = review;
    setRefused(null);
    try {
      await sendCreate(startOp(requestKey, shape(rest as unknown as P)));
    } catch (err) {
      setRefused(o.refusal(err)); // the one-at-a-time guard refused: nothing was sent
    }
  }

  /** A new review at the price the server named (a coupon or a changed price): a new request with a new key. */
  function payAtNewPrice(priceMinor: number) {
    if (!review) return;
    const requestKey = newRequestKey();
    setRefused(null);
    setReview({ ...review, requestKey, request: { ...review.request, requestKey, acceptedPriceMinor: priceMinor },
      summary: { ...review.summary, priceMinor, couponChecked: true } });
  }

  async function giveUp(p: PendingOp<P>) {
    setResendError(null);
    setGivingUp(true);
    try {
      const r = await o.perform(() => o.abandon(p.requestKey));
      if (r.state === 'used') {
        const left = o.onUsed(r as A & { state: 'used' }, p, !!p.restored || !p.body);
        if (left) setResendError(left);
        return;
      }
      // Only `abandoned` means given up; any other answer leaves it unknown (the panel stays).
      if (r.state !== 'abandoned') { setResendError(t('common.itCouldNotBeGiven')); return; }
      settle(p.requestKey);
      setReview(null);
      o.onNotice(t('assistedCreate.givenUpWithThatRequest', { nothing }));
    } catch (err) {
      setResendError(o.refusal(err).message);
    } finally {
      setGivingUp(false);
    }
  }

  /** A check by key found the request given up. */
  function abandonedByCheck(requestKey: string) {
    settle(requestKey);
    setReview(null);
    o.onNotice(t('assistedCreate.thatBookingWasGivenUp', { nothing }));
  }

  return { op, settle, review, setReview, refused, setRefused, resendError, setResendError, givingUp, send: sendCreate, pay, payAtNewPrice, giveUp, rotateKey,
    refresh, abandonedByCheck };
}
