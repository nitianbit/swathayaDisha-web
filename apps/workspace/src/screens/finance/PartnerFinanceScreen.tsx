import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { hasGlobalScope, holdsAny, partnerFinanceApi } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { useSession } from '../../session.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from '../partner/scope.tsx';
import {
  EventsList, ListSection, PayoutDetailsForm, PayoutDetailsList, PayoutsTable, StatementSection, SummaryCards,
} from './finance.tsx';

/**
 * Partner finance (`/partner/finance`; admins as owner at `/admin/partners/:partnerId/finance`): balance and totals, the
 * statement with its running balance (and CSV), payouts, finance events, and where payouts are sent. Members need
 * `finance.view` AND partner-wide scope (`assertPartnerFinanceReader`); only owners (and admins) change the destination.
 */
export function PartnerFinanceScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // The route declaration already hides this page from anyone else; this repeats the backend's rule for the screen.
  if (!holdsAny(ctx.actor, ['finance.view']) || !hasGlobalScope(ctx.actor)) return <NoSuchPartner />;
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
  const payouts = useQuery({ queryKey: [...key, 'payouts'], queryFn: () => fin.payouts() });
  const events = useQuery({ queryKey: [...key, 'events'], queryFn: () => fin.events() });
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const isOwner = ctx.actor.role === 'owner';
  const admin = !!ctx.adminHome;
  const name = partner.data?.name;

  const reload = () => void queryClient.invalidateQueries({ queryKey: key });
  const s = summary.data;
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Finance" partnerName={name}>
        Money Jansetu collected online for {name ?? 'this partner'} and paid out. Bills paid at the counter are not part of it.
      </PartnerPageHeading>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {summary.isPending ? <Loading label="Loading finance…" />
        : summary.isError || !s ? <ErrorState message={messageOf(summary.error)} onRetry={() => void summary.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="fin-bal-h">
              <h2 id="fin-bal-h">Balance</h2>
              {!s.account ? (
                <Empty title="Nothing earned yet">Earnings from online bookings appear here once the first one is completed.</Empty>
              ) : <SummaryCards summary={s} />}
            </section>

            <section className="ws-section" aria-labelledby="fin-dest-h">
              <h2 id="fin-dest-h">Where payouts are sent</h2>
              <Alert tone="warn">
                Any change to these details, even to the same values, must be verified again by Jansetu before the next payout.
                Payouts wait until then.
              </Alert>
              {s.account?.payoutDetails ? <PayoutDetailsList account={s.account} />
                : <p className="ws-muted">No payout details yet{isOwner ? ': add a bank account or UPI ID so Jansetu can pay out the balance.' : '.'}</p>}
              {s.account?.payoutDetailsState === 'unverified' && <p className="ws-muted">Jansetu has not verified these details yet; no payout is made until it has.</p>}
              {!isOwner ? (
                <p className="ws-muted">Only an owner can change where payouts are sent.</p>
              ) : editing ? (
                <PayoutDetailsForm account={s.account} audience={admin ? 'admin' : 'owner'}
                  reread={async () => (await fin.summary()).account}
                  save={(body) => fin.setPayoutDetails(body)}
                  onSaved={(a) => {
                    setEditing(false);
                    setNotice({ tone: 'ok', text: `Payout details saved (version ${a.payoutDetailsVersion}). They wait for Jansetu’s verification; no payout is made until then.` });
                    reload();
                  }}
                  onLost={(text) => { setEditing(false); setNotice({ tone: 'warn', text }); reload(); }}
                  onStale={reload}
                  onCancel={() => setEditing(false)} />
              ) : (
                <div><Button variant="secondary" onClick={() => { setNotice(null); setEditing(true); }}>{s.account?.payoutDetails ? 'Change payout details' : 'Add payout details'}</Button></div>
              )}
            </section>

            {s.account && (
              <StatementSection queryKey={key} load={(q) => fin.statement(q)} csv={(q, signal) => fin.statementCsv(q, signal)}
                csvPrefix="partner" emptyText="Earnings, payouts and adjustments appear here." />
            )}
          </>
        )}
      <ListSection id="fin-po-h" title="Payouts" q={payouts} empty="Transfers Jansetu records appear here.">
        {(rows) => <PayoutsTable payouts={rows} caption="Payouts, newest first" />}
      </ListSection>
      <ListSection id="fin-ev-h" title="Finance events" q={events} empty="Changes to payout details, payouts and adjustments appear here.">
        {(rows) => <EventsList events={rows} selfId={ctx.actor.memberId} />}
      </ListSection>
    </>
  );
}
