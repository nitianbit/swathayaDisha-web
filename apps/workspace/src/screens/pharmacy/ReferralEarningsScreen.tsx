import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pharmacyReferralApi, REFERRAL_CATEGORIES, REFERRAL_CATEGORY_LABEL, referralCutsOn, referralRowOf, referralRuleText } from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { Signed } from '../finance/finance.tsx';
import { CursorPager, useCursorPages } from './cursorList.tsx';
import { usePharmacyId } from './ownedOp.tsx';

/**
 * WQ26 (phase 4b): what the pharmacy's referral cuts earned (`GET /pharmacy-assisted/referral`), its rates
 * (`/referral-rules`) and the statement (`/referral/statement`, newest first in cursor pages). Read only. Payouts are paused
 * until the CA answers (O1), so what is earned shows as due. Rows name a booking by its short ref, never the patient.
 */
export function ReferralEarningsScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title="Referral earnings">
        What your pharmacy earns for the consultations and lab tests it books for patients. It comes out of the doctor’s or the lab’s earning, not from the patient.
      </PageHeading>
      <ReferralEarnings key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

function ReferralEarnings({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const r = pharmacyReferralApi(api);
  const key = ['pharmacy-referral', pharmacyId];
  const summary = useQuery({ queryKey: [...key, 'summary'], queryFn: () => r.summary() });
  const rules = useQuery({ queryKey: [...key, 'rules'], queryFn: () => r.rules() });
  const pages = useCursorPages();
  const statement = useQuery({ queryKey: [...key, 'statement', pages.cursor], queryFn: () => r.statement(pages.cursor || undefined) });
  const s = summary.data;
  return (
    <>
      <section className="ws-section" aria-labelledby="ref-sum-h">
        <h2 id="ref-sum-h">Earnings</h2>
        {summary.isPending ? <Loading label="Loading your referral earnings…" />
          : summary.isError || !s ? <ErrorState message={messageOf(summary.error)} onRetry={() => void summary.refetch()} />
          : (
            <>
              <dl className="fin-cards" aria-label="Referral earnings">
                <div className="fin-card fin-card--main"><dt>Due to you</dt><dd><Signed minor={s.dueMinor} /></dd></div>
                <div className="fin-card"><dt>Earned</dt><dd>{formatPaise(s.earnedMinor)}</dd></div>
                <div className="fin-card"><dt>Paid to you</dt><dd>{formatPaise(s.paidMinor)}</dd></div>
              </dl>
              {!s.payoutsEnabled && <p>Payouts start once Jansetu switches them on.</p>}
            </>
          )}
      </section>

      <section className="ws-section" aria-labelledby="ref-rates-h">
        <h2 id="ref-rates-h">Your rates</h2>
        {rules.isPending ? <Loading label="Loading your rates…" />
          : rules.isError ? <ErrorState message={messageOf(rules.error)} onRetry={() => void rules.refetch()} />
          : (
            <>
              <dl className="ws-dl">
                {REFERRAL_CATEGORIES.map((c) => (
                  <Fragment key={c}>
                    <dt>{REFERRAL_CATEGORY_LABEL[c]}</dt><dd>{referralRuleText(rules.data.find((x) => x.category === c))}</dd>
                  </Fragment>
                ))}
              </dl>
              {referralCutsOn(rules.data) === false && <p className="ws-muted">Jansetu has not switched referral cuts on yet, so new bookings earn no cut for now.</p>}
              <p className="ws-muted">Jansetu sets these rates. A booking keeps the rate it was made with; the cut is earned when it is completed.</p>
            </>
          )}
      </section>

      <section className="ws-section" aria-labelledby="ref-st-h">
        <h2 id="ref-st-h">Statement</h2>
        {statement.isPending ? <Loading label="Loading the statement…" />
          : statement.isError ? <ErrorState message={messageOf(statement.error)} onRetry={() => void statement.refetch()} />
          : statement.data.items.length === 0 && pages.page === 1 ? <Empty title="No referral earnings yet">A cut is listed here when a booking you made is completed.</Empty>
          : (
            <>
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">Referral statement, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date (India time)</th><th scope="col">Ref</th><th scope="col">Category</th>
                      <th scope="col" className="fin-amount">Base</th><th scope="col" className="fin-amount">Cut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.data.items.map(referralRowOf).map((row) => (
                      <tr key={row._id}>
                        <td>{formatDateTime(row.at)}</td>
                        <td>{row.ref ?? '—'}</td>
                        <td>{row.category}</td>
                        <td className="fin-amount">{row.baseMinor === null ? '—' : formatPaise(row.baseMinor)}</td>
                        <td className="fin-amount"><Signed minor={row.cutMinor} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <CursorPager pages={pages} nextCursor={statement.data.nextCursor} label="Statement pages" />
            </>
          )}
      </section>
    </>
  );
}
