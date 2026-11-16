import { useEffect, useState } from 'react';

/**
 * The price the customer has seen and agreed to, per context (what is being bought: items, doctor, coupon, patient).
 * The first price shown for a context counts as seen. If the price for the SAME context later changes (a server
 * re-read, a coupon re-check), nothing can be sent until the customer accepts the new price: a request is only ever
 * sent with a price the customer agreed to (backend Q9 then refuses any other).
 *
 * `ready` = false while the price is still being worked out (e.g. a coupon being re-checked): nothing counts as seen.
 */
export interface Agreement { ctx: string; price: string }

export function agreementState(agreed: Agreement | null, ctx: string, price: string, ready: boolean) {
  if (!ready) return { agreed: false, changed: false } as const;
  if (!agreed || agreed.ctx !== ctx) return { agreed: false, changed: false, firstSight: true } as const;
  return agreed.price === price ? { agreed: true, changed: false } as const : { agreed: false, changed: true, previous: agreed.price } as const;
}

export function usePriceAgreement(ctx: string, price: string, ready: boolean) {
  const [agreed, setAgreed] = useState<Agreement | null>(null);
  // First sight of a context: the price on screen is the one agreed to.
  useEffect(() => {
    if (ready) setAgreed((cur) => (!cur || cur.ctx !== ctx ? { ctx, price } : cur));
  }, [ctx, price, ready]);
  const s = agreementState(agreed, ctx, price, ready);
  return { agreed: s.agreed, changed: s.changed, previous: 'previous' in s ? s.previous : undefined, accept: () => setAgreed({ ctx, price }) };
}
