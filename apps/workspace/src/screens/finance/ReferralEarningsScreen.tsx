import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  hasGlobalScope, holdsAny, LEDGER_KIND_LABEL, referralReadsApi, referralRowOf, referralRuleText, type ReferralCategory, type ReferralReader, type ReferralRow,
} from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { t } from '../../i18n/referral/index.ts';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { CursorPager, useCursorPages } from '../pharmacy/cursorList.tsx';
import { usePharmacyId } from '../pharmacy/ownedOp.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from '../partner/scope.tsx';
import { CsvDownload, Signed } from './finance.tsx';

/**
 * WQ26 / WQ26b (r33): a booking partner's referral earnings, one page for a pharmacy (`/pharmacy-assisted/referral*`) and a
 * lab (`/partner-workspace/assisted/referral*`, members with `finance.view` and partner-wide scope): what its cuts earned,
 * were paid and are due, its rates (read only), and the statement (date, short ref, category, base, cut; a lab booking's
 * cut lines under it) in cursor pages, with its CSV. Payouts are paused until the CA answers (O1). No patient names.
 */
export function PharmacyReferralEarningsScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title={t('referralEarnings.referralEarnings')}>{t('referralEarnings.whatYourPharmacyEarnsFor')}</PageHeading>
      <ReferralEarnings key={pharmacyId} reader={{ kind: 'pharmacy' }} queryKey={['pharmacy-referral', pharmacyId]}
        categories={['consultation', 'lab_test', 'lab_package']} />
    </>
  );
}

/** `/partner/referral`: a lab's own (the route and the server: `finance.view` and partner-wide scope; labs book consultations). */
export function LabReferralEarningsScreen() {
  const ctx = usePartnerScope();
  if (!ctx || ctx.scope.kind !== 'member') return <NoSuchPartner />;
  // The route declaration already hides this page from anyone else; this repeats the backend's rule for the screen.
  if (!holdsAny(ctx.actor, ['finance.view']) || !hasGlobalScope(ctx.actor)) return <NoSuchPartner />;
  return <LabReferralEarnings key={scopeIdentity(ctx)} ctx={ctx} />;
}

function LabReferralEarnings({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  return (
    <>
      <PartnerPageHeading ctx={ctx} title={t('referralEarnings.referralEarnings')} partnerName={partner.data?.name}>
        {t('referralEarnings.whatYourLabEarnsFor')}
      </PartnerPageHeading>
      <ReferralEarnings reader={{ kind: 'lab', scope: ctx.scope }} queryKey={[...ctx.key, 'referral']} categories={['consultation']} />
    </>
  );
}

const categoryWord = (c: ReferralCategory | 'mixed') => t(`referralEarnings.category.${c}`);

function ReferralEarnings({ reader, queryKey, categories }: { reader: ReferralReader; queryKey: readonly string[]; categories: readonly ReferralCategory[] }) {
  const { api } = useSession();
  const r = referralReadsApi(api, reader);
  const summary = useQuery({ queryKey: [...queryKey, 'summary'], queryFn: () => r.summary() });
  const rules = useQuery({ queryKey: [...queryKey, 'rules'], queryFn: () => r.rules() });
  const pages = useCursorPages();
  const statement = useQuery({ queryKey: [...queryKey, 'statement', pages.cursor], queryFn: () => r.statement(pages.cursor || undefined) });
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
                {categories.map((c) => (
                  <Fragment key={c}>
                    <dt>{categoryWord(c)}</dt><dd>{referralRuleText(rules.data.rules.find((x) => x.category === c))}</dd>
                  </Fragment>
                ))}
              </dl>
              {rules.data.switches?.cutsEnabled === false && <p className="ws-muted">{t('referralEarnings.jansetuHasNotSwitchedReferral')}</p>}
              <p className="ws-muted">{t('referralEarnings.jansetuSetsTheseRatesA')}</p>
            </>
          )}
      </section>

      <section className="ws-section" aria-labelledby="ref-st-h">
        <h2 id="ref-st-h">{t('referralEarnings.statement')}</h2>
        <CsvDownload period={{}} csv={(q, signal) => r.statementCsv(q, signal)} csvPrefix={`${reader.kind}-referral`} />
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
                      <th scope="col">{t('referralEarnings.dateIndiaTime')}</th><th scope="col">{t('referralEarnings.ref')}</th>
                      <th scope="col">{t('referralEarnings.category')}</th>
                      <th scope="col" className="fin-amount">{t('referralEarnings.base')}</th><th scope="col" className="fin-amount">{t('referralEarnings.cut')}</th>
                    </tr>
                  </thead>
                  <tbody>{statement.data.items.map(referralRowOf).map((row) => <StatementRow key={row._id} row={row} />)}</tbody>
                </table>
              </div>
              <CursorPager pages={pages} nextCursor={statement.data.nextCursor} label={t('referralEarnings.statementPages')} />
            </>
          )}
      </section>
    </>
  );
}

/** One statement row; a lab booking with several cut lines lists them under its category, one short line each. */
function StatementRow({ row }: { row: ReferralRow }) {
  return (
    <tr>
      <td>{formatDateTime(row.at)}</td>
      <td>{row.ref ?? '—'}</td>
      <td>
        {row.category ? categoryWord(row.category) : LEDGER_KIND_LABEL[row.kind] ?? row.kind}
        {row.lines.length > 1 && (
          <ul className="ws-muted ref-lines">
            {row.lines.map((l, i) => (
              <li key={i}>{t('referralEarnings.line', { category: categoryWord(l.category), base: formatPaise(l.baseMinor), cut: formatPaise(l.cutMinor) })}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="fin-amount">{row.baseMinor === null ? '—' : formatPaise(row.baseMinor)}</td>
      <td className="fin-amount"><Signed minor={row.cutMinor} /></td>
    </tr>
  );
}
