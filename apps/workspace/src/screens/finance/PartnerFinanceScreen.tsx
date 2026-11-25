import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isFinanceReader, partnerFinanceApi } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/finance/index.ts';
import { useSession } from '../../session.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from '../partner/scope.tsx';
import {
  EventsList, PagedSection, PayoutDetailsForm, PayoutDetailsList, PayoutsTable, StatementSection, SummaryCards,
} from './finance.tsx';
import { OwnerFinanceTiles } from './financeTiles.tsx';

/** Q13 cursor pages of payouts and finance events. */
const PAGE = 50;

/**
 * Partner finance (`/partner/finance`; admins as owner at `/admin/partners/:partnerId/finance`): balance and totals, the
 * statement with its running balance (and CSV), payouts, finance events, and where payouts are sent. Members need
 * `finance.view` AND partner-wide scope (`assertPartnerFinanceReader`); only owners (and admins) change the destination.
 */
export function PartnerFinanceScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // The route declaration already hides this page from anyone else; this repeats the backend's rule for the screen.
  if (!isFinanceReader(ctx.actor)) return <NoSuchPartner />;
  // One subtree per partner: an open form, a download or a late answer never carries over to another partner.
  return <PartnerFinance key={scopeIdentity(ctx)} ctx={ctx} />;
}

function PartnerFinance({ ctx }: { ctx: ScopeContext }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const fin = useMemo(() => partnerFinanceApi(api, ctx.scope), [api, ctx.scope]);
  const partner = useWorkspacePartner(ctx);
  const key = [...ctx.key, 'finance'];
  const summary = useQuery({ queryKey: [...key, 'summary'], queryFn: () => fin.summary() });
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const isOwner = ctx.actor.role === 'owner';
  const admin = !!ctx.adminHome;
  const name = partner.data?.name;

  const reload = () => void queryClient.invalidateQueries({ queryKey: key });
  const s = summary.data;
  return (
    <>
      <PartnerPageHeading ctx={ctx} title={t('partner.title')} partnerName={name}>
        {name != null ? t('partner.intro', { name }) : t('partner.introUnnamed')}
      </PartnerPageHeading>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {summary.isPending ? <Loading label={t('partner.loading')} />
        : summary.isError || !s ? <ErrorState message={messageOf(summary.error)} onRetry={() => void summary.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="fin-bal-h">
              <h2 id="fin-bal-h">{t('balance.title')}</h2>
              {!s.account ? (
                <Empty title={t('partner.nothingEarned')}>{t('partner.nothingEarnedText')}</Empty>
              ) : <SummaryCards summary={s} />}
              {/* WQ48 (r35 §26.10): a lab's referral earnings (its own page stays, linked for members) and withdrawals. */}
              <OwnerFinanceTiles referral={s.referral} withdrawals={s.withdrawals} referralLink={admin ? undefined : '/partner/referral'} />
            </section>

            <section className="ws-section" aria-labelledby="fin-dest-h">
              <h2 id="fin-dest-h">{t('partner.destination')}</h2>
              <Alert tone="warn">{t('partner.destinationWarning')}</Alert>
              {s.account?.payoutDetails ? <PayoutDetailsList account={s.account} />
                : <p className="ws-muted">{isOwner ? t('partner.noDetailsOwner') : t('details.noneYet')}</p>}
              {s.account?.payoutDetailsState === 'unverified' && <p className="ws-muted">{t('partner.unverified')}</p>}
              {!isOwner ? (
                <p className="ws-muted">{t('partner.ownerOnly')}</p>
              ) : editing ? (
                <PayoutDetailsForm account={s.account} audience={admin ? 'admin' : 'owner'}
                  reread={async () => (await fin.summary()).account}
                  save={(body, version) => fin.setPayoutDetails(body, version)}
                  onSaved={(a) => {
                    setEditing(false);
                    setNotice({ tone: 'ok', text: t('partner.saved', { version: a.payoutDetailsVersion }) });
                    reload();
                  }}
                  onLost={(text) => { setEditing(false); setNotice({ tone: 'warn', text }); reload(); }}
                  onStale={reload}
                  onCancel={() => setEditing(false)} />
              ) : (
                <div><Button variant="secondary" onClick={() => { setNotice(null); setEditing(true); }}>{s.account?.payoutDetails ? t('details.change') : t('details.add')}</Button></div>
              )}
            </section>

            {s.account && (
              <StatementSection queryKey={key} load={(q) => fin.statement(q)} csv={(q, signal) => fin.statementCsv(q, signal)}
                // i18n-ignore: the start of the CSV file name, not words
                csvPrefix="partner" />
            )}
          </>
        )}
      <PagedSection id="fin-po-h" title={t('payouts.title')} loading={t('payouts.loading')} emptyTitle={t('payouts.empty')}
        queryKey={[...key, 'payouts']} load={(cursor) => fin.payouts({ cursor, limit: PAGE })}
        empty={t('payouts.emptyText.partner')} more={t('payouts.older')}>
        {(rows) => <PayoutsTable payouts={rows} caption={t('payouts.caption.partner')} />}
      </PagedSection>
      <PagedSection id="fin-ev-h" title={t('events.title')} loading={t('events.loading')} emptyTitle={t('events.empty')}
        queryKey={[...key, 'events']} load={(cursor) => fin.events({ cursor, limit: PAGE })}
        empty={t('events.emptyText')} more={t('events.older')}>
        {(rows) => <EventsList events={rows} selfId={ctx.actor.memberId} />}
      </PagedSection>
    </>
  );
}
