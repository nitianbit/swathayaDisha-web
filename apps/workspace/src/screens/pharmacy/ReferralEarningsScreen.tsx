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
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ26 (phase 4b): what the pharmacy's referral cuts earned (`GET /pharmacy-assisted/referral`), its rates
 * (`/referral-rules`) and the statement (`/referral/statement`, newest first in cursor pages). Read only. Payouts are paused
 * until the CA answers (O1), so what is earned shows as due. Rows name a booking by its short ref, never the patient.
 */
export function ReferralEarningsScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title={t('referralEarnings.referralEarnings')}>{t('referralEarnings.whatYourPharmacyEarnsFor')}</PageHeading>
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
        <h2 id="ref-sum-h">{t('referralEarnings.earnings')}</h2>
        {summary.isPending ? <Loading label={t('referralEarnings.loadingYourReferralEarnings')} />
          : summary.isError || !s ? <ErrorState message={messageOf(summary.error)} onRetry={() => void summary.refetch()} />
          : (
            <>
              <dl className="fin-cards" aria-label={t('referralEarnings.referralEarnings')}>
                <div className="fin-card fin-card--main"><dt>{t('referralEarnings.dueToYou')}</dt><dd><Signed minor={s.dueMinor} /></dd></div>
                <div className="fin-card"><dt>{t('referralEarnings.earned')}</dt><dd>{formatPaise(s.earnedMinor)}</dd></div>
                <div className="fin-card"><dt>{t('referralEarnings.paidToYou')}</dt><dd>{formatPaise(s.paidMinor)}</dd></div>
              </dl>
              {!s.payoutsEnabled && <p>{t('referralEarnings.payoutsStartOnceJansetuSwitches')}</p>}
            </>
          )}
      </section>

      <section className="ws-section" aria-labelledby="ref-rates-h">
        <h2 id="ref-rates-h">{t('referralEarnings.yourRates')}</h2>
        {rules.isPending ? <Loading label={t('referralEarnings.loadingYourRates')} />
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
              {referralCutsOn(rules.data) === false && <p className="ws-muted">{t('referralEarnings.jansetuHasNotSwitchedReferral')}</p>}
              <p className="ws-muted">{t('referralEarnings.jansetuSetsTheseRatesA')}</p>
            </>
          )}
      </section>

      <section className="ws-section" aria-labelledby="ref-st-h">
        <h2 id="ref-st-h">{t('referralEarnings.statement')}</h2>
        {statement.isPending ? <Loading label={t('referralEarnings.loadingTheStatement')} />
          : statement.isError ? <ErrorState message={messageOf(statement.error)} onRetry={() => void statement.refetch()} />
          : statement.data.items.length === 0 && pages.page === 1 ? <Empty title={t('referralEarnings.noReferralEarningsYet')}>{t('referralEarnings.aCutIsListedHere')}</Empty>
          : (
            <>
              <div className="ws-table-wrap">
                <table className="j-table">
                  <caption className="j-sr-only">{t('referralEarnings.referralStatementNewestFirst')}</caption>
                  <thead>
                    <tr>
                      <th scope={'col'}>{t('referralEarnings.dateIndiaTime')}</th><th scope={'col'}>{t('referralEarnings.ref')}</th><th scope={'col'}>{t('referralEarnings.category')}</th>
                      <th scope={'col'} className="fin-amount">{t('referralEarnings.base')}</th><th scope={'col'} className="fin-amount">{t('referralEarnings.cut')}</th>
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
              <CursorPager pages={pages} nextCursor={statement.data.nextCursor} label={t('referralEarnings.statementPages')} />
            </>
          )}
      </section>
    </>
  );
}
