import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  isFinanceReader, LEDGER_KIND_LABEL, referralReadsApi, referralRowOf, referralRuleText, type Page, type PeriodQuery, type ReferralCategory,
  type ReferralReader, type ReferralRow, type ReferralStatementLine,
} from '@jansetu/api';
import { formatPaise } from '@jansetu/i18n';
import { Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { t } from '../../i18n/referral/index.ts';
import { messageOf } from '../../errors.ts';
import { useSession } from '../../session.tsx';
import { CursorPager, useCursorPages } from '../pharmacy/cursorList.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from '../partner/scope.tsx';
import { Signed, StatementPeriodFields, useStatementPeriod } from './finance.tsx';

/**
 * WQ26 / WQ26b (r33): a booking partner's referral earnings (WQ48: the pharmacy's are on its Finance page; its rates and its
 * statement come from here), one page for a pharmacy (`/pharmacy-assisted/referral*`, until WQ48) and a
 * lab (`/partner-workspace/assisted/referral*`, members with `finance.view` and partner-wide scope): what its cuts earned,
 * were paid and are due, its rates (read only), and the statement (date, short ref, category, base, cut; a lab booking's
 * cut lines under it) in cursor pages, of a period with its CSV (the finance statements' period fields). Payouts are paused
 * until the CA answers (O1). No patient names. WQ26c: a failed read again keeps what was read (data first, then the error).
 */
/** `/partner/referral`: a lab's own (the route and the server: `finance.view` and partner-wide scope; labs book consultations). */
export function LabReferralEarningsScreen() {
  const ctx = usePartnerScope();
  if (!ctx || ctx.scope.kind !== 'member') return <NoSuchPartner />;
  // The route declaration already hides this page from anyone else; this repeats the backend's rule for the screen.
  if (!isFinanceReader(ctx.actor)) return <NoSuchPartner />;
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

/** A category's word; a code this page does not know (a newer server) is shown as sent. */
const categoryWord = (c: string) => {
  const key = `referralEarnings.category.${c}`;
  return t.has(key) ? t(key) : c;
};

function ReferralEarnings({ reader, queryKey, categories }: { reader: ReferralReader; queryKey: readonly string[]; categories: readonly ReferralCategory[] }) {
  const { api } = useSession();
  const r = referralReadsApi(api, reader);
  const summary = useQuery({ queryKey: [...queryKey, 'summary'], queryFn: () => r.summary() });
  const rules = useReferralRules(reader, queryKey);
  const statementPeriod = useStatementPeriod();
  const s = summary.data;
  return (
    <>
      <section className="ws-section" aria-labelledby="ref-sum-h">
        <h2 id="ref-sum-h">{t('referralEarnings.earnings')}</h2>
        {!s ? (summary.isError ? <ErrorState message={messageOf(summary.error)} onRetry={() => void summary.refetch()} />
          : <Loading label={t('referralEarnings.loadingYourReferralEarnings')} />)
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
        <ReferralRates q={rules} categories={categories} />
      </section>

      <section className="ws-section" aria-labelledby="ref-st-h">
        <h2 id="ref-st-h">{t('referralEarnings.statement')}</h2>
        <StatementPeriodFields p={statementPeriod} csv={(q, signal) => r.statementCsv(q, signal)} csvPrefix={`${reader.kind}-referral`} />
        {statementPeriod.period && (
          <StatementList key={JSON.stringify(statementPeriod.period)} load={r.statement} queryKey={[...queryKey, 'statement']} period={statementPeriod.period}
            filtered={statementPeriod.filtered} />
        )}
      </section>
    </>
  );
}

/** The booker's rates with the switches (WQ48: also on the pharmacy's Finance page). */
export function useReferralRules(reader: ReferralReader, queryKey: readonly unknown[]) {
  const { api } = useSession();
  return useQuery({ queryKey: [...queryKey, 'rules'], queryFn: () => referralReadsApi(api, reader).rules() });
}

/** The rates per category, read only (Jansetu sets them). */
export function ReferralRates({ q, categories }: { q: ReturnType<typeof useReferralRules>; categories: readonly ReferralCategory[] }) {
  if (!q.data) return q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} /> : <Loading label={t('referralEarnings.loadingYourRates')} />;
  const rules = q.data;
  return (
    <>
      <dl className="ws-dl">
        {categories.map((c) => (
          <Fragment key={c}>
            <dt>{categoryWord(c)}</dt><dd>{referralRuleText(rules.rules.find((x) => x.category === c))}</dd>
          </Fragment>
        ))}
      </dl>
      {rules.switches?.cutsEnabled === false && <p className="ws-muted">{t('referralEarnings.jansetuHasNotSwitchedReferral')}</p>}
      <p className="ws-muted">{t('referralEarnings.jansetuSetsTheseRatesA')}</p>
    </>
  );
}

/**
 * The statement of one period, newest first in cursor pages (keyed by the period: a new period starts at its first page).
 * WQ48: also the pharmacy Finance statement's "Referral earnings" (`load`: its `kind=referral` read, the same signature).
 */
export function StatementList({ load, queryKey, period, filtered }: {
  load: (before?: string, limit?: number, q?: PeriodQuery) => Promise<Page<ReferralStatementLine>>; queryKey: readonly unknown[]; period: PeriodQuery; filtered: boolean;
}) {
  const pages = useCursorPages();
  const statement = useQuery({ queryKey: [...queryKey, period, pages.cursor], queryFn: () => load(pages.cursor || undefined, undefined, period) });
  if (!statement.data) {
    return statement.isError ? <ErrorState message={messageOf(statement.error)} onRetry={() => void statement.refetch()} />
      : <Loading label={t('referralEarnings.loadingTheStatement')} />;
  }
  if (statement.data.items.length === 0 && pages.page === 1) {
    return filtered ? <Empty title={t('referralEarnings.noEntries')}>{t('referralEarnings.nothingInThisPeriod')}</Empty>
      : <Empty title={t('referralEarnings.noReferralEarningsYet')}>{t('referralEarnings.aCutIsListedHere')}</Empty>;
  }
  return (
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
  );
}

/**
 * One statement row; a lab booking lists its cut lines under its category, one short line each, when there are several or
 * when its one cut line is not the whole booking (another line was not cut).
 */
function StatementRow({ row }: { row: ReferralRow }) {
  return (
    <tr>
      <td>{formatDateTime(row.at)}</td>
      <td>{row.ref ?? '—'}</td>
      <td>
        {row.category ? categoryWord(row.category) : LEDGER_KIND_LABEL[row.kind] ?? row.kind}
        {(row.lines.length > 1 || (row.lines.length === 1 && row.baseMinor !== null && row.lines[0]!.baseMinor !== row.baseMinor)) && (
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
