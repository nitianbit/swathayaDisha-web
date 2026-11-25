import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DETAILS_STATE_LABEL, pharmacyFinanceApi, pharmacyPayoutApi, pharmacyWithdrawalsApi, REFERRAL_CATEGORIES, type FinanceStatementKind, type Page,
  type PeriodQuery, type PharmacyFinance, type WalletMovement,
} from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/finance/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { detailsTone, PayoutDetailsForm, StatementPeriodFields, useStatementPeriod } from '../finance/finance.tsx';
import { CardMoneyTile, FinanceTiles, ReferralTile, WalletTile } from '../finance/financeTiles.tsx';
import { ReferralRates, StatementList, useReferralRules } from '../finance/ReferralEarningsScreen.tsx';
import { CursorPager, useCursorPages } from './cursorList.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { MovementsTable } from './WalletScreen.tsx';
import { WithdrawSection } from './withdrawals.tsx';

/**
 * WQ48 (backend r35 round 4f, design §26.10): the pharmacy's Finance page, one place for its money: three tiles (the
 * wallet with what is withdrawable now and later, its card money, what referral cuts earned, were paid and are due), the
 * one action (Withdraw to bank, the shared `withdrawals.tsx`), where withdrawals are sent (the shared payout-details form,
 * prefilled from the masked details: the account number is typed again), one statement with a Wallet / Referral earnings
 * choice, a period and its CSV, and the referral rates (the former "Referral earnings" page, folded in here).
 */
export function PharmacyFinanceScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title={t('pharmacy.title')}>{t('pharmacy.intro')}</PageHeading>
      <PharmacyFinance key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

function PharmacyFinance({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  // Under the wallet's key: a withdrawal (or a cancel) reads the wallet again, and these blocks with it.
  const walletKey = ['pharmacy-wallet', pharmacyId] as const;
  const summary = useQuery({ queryKey: [...walletKey, 'finance'], queryFn: () => pharmacyFinanceApi(api).summary() });
  const rules = useReferralRules({ kind: 'pharmacy' }, ['pharmacy-referral', pharmacyId]);
  const s = summary.data;
  return (
    <>
      <section className="ws-section" aria-labelledby="pf-bal-h">
        <h2 id="pf-bal-h">{t('balance.title')}</h2>
        {!s ? (summary.isError ? <ErrorState message={messageOf(summary.error)} onRetry={() => void summary.refetch()} /> : <Loading label={t('pharmacy.loading')} />)
          : (
            <FinanceTiles>
              <WalletTile wallet={s.wallet} />
              <CardMoneyTile wallet={s.wallet} />
              <ReferralTile referral={s.referral} />
            </FinanceTiles>
          )}
      </section>

      <WithdrawSection source={{ owner: `pharmacy:${pharmacyId}`, walletKey, api: pharmacyWithdrawalsApi(api), canAct: true, destination: { onPage: true } }} />

      {s && <PayoutDetails d={s.payoutDetails} walletKey={walletKey} />}

      <FinanceStatement pharmacyId={pharmacyId} />

      <section className="ws-section" aria-labelledby="pf-ref-h">
        <h2 id="pf-ref-h">{t('pharmacy.referralTitle')}</h2>
        <ReferralRates q={rules} categories={REFERRAL_CATEGORIES} />
        <p className="ws-muted">{t('pharmacy.referralHint')}</p>
      </section>
    </>
  );
}

/** Where withdrawals are sent: the masked line and its state, and the shared form (a change waits for Jansetu's check). */
function PayoutDetails({ d, walletKey }: { d: PharmacyFinance['payoutDetails']; walletKey: readonly unknown[] }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const reload = () => void queryClient.invalidateQueries({ queryKey: walletKey });
  return (
    <section className="ws-section" aria-labelledby="pf-dest-h">
      <h2 id="pf-dest-h">{t('details.title')}</h2>
      <p className="ws-muted">{t('pharmacy.detailsIntro')}</p>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {d.state === 'none' || !d.masked ? <p className="ws-muted">{t('details.noneYet')}</p>
        : <p>{d.masked} <Badge tone={detailsTone(d.state)}>{DETAILS_STATE_LABEL[d.state] ?? d.state}</Badge></p>}
      {editing ? (
        <PayoutDetailsForm account={{ payoutDetails: d.details, payoutDetailsVersion: d.detailsVersion }} audience={'owner'}
          reread={async () => {
            const now = (await pharmacyFinanceApi(api).summary()).payoutDetails;
            return { payoutDetails: now.details, payoutDetailsVersion: now.detailsVersion };
          }}
          save={(body, version) => pharmacyPayoutApi(api).setPayoutDetails(body, version)}
          onSaved={() => { setEditing(false); setNotice({ tone: 'ok', text: t('pharmacy.detailsSaved') }); reload(); }}
          onLost={(text) => { setEditing(false); setNotice({ tone: 'warn', text }); reload(); }}
          onStale={reload}
          onCancel={() => setEditing(false)} />
      ) : (
        <div><Button variant="secondary" onClick={() => { setNotice(null); setEditing(true); }}>{d.state === 'none' ? t('details.add') : t('details.change')}</Button></div>
      )}
    </section>
  );
}

/** One statement: the wallet's rows or the referral account's lines, of a period, with that period's CSV. */
function FinanceStatement({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const fin = pharmacyFinanceApi(api);
  const [kind, setKind] = useState<FinanceStatementKind>('wallet');
  const p = useStatementPeriod();
  const queryKey = ['pharmacy-wallet', pharmacyId, 'finance-statement', kind];
  return (
    <section className="ws-section" aria-labelledby="pf-st-h">
      <h2 id="pf-st-h">{t('statement.title')}</h2>
      <div className="ws-filter">
        <div className="j-field">
          <label htmlFor="pf-kind">{t('statement.show')}</label>
          <select id="pf-kind" value={kind} onChange={(e) => setKind(e.target.value === 'referral' ? 'referral' : 'wallet')}>
            <option value="wallet">{t('statement.kind.wallet')}</option>
            <option value="referral">{t('statement.kind.referral')}</option>
          </select>
        </div>
      </div>
      {/* Keyed by the kind: a download made for the other statement is dropped. */}
      <StatementPeriodFields key={kind} p={p} csv={(q, signal) => fin.statementCsv(kind, q, signal)} csvPrefix={`pharmacy-${kind}`} />
      {p.period && (kind === 'referral'
        ? <StatementList key={`referral:${JSON.stringify(p.period)}`} load={fin.referralStatement} queryKey={queryKey} period={p.period} filtered={p.filtered} />
        : <WalletStatement key={`wallet:${JSON.stringify(p.period)}`} load={fin.walletStatement} queryKey={queryKey} period={p.period} filtered={p.filtered} />)}
    </section>
  );
}

/** The wallet's rows of one period, newest first in cursor pages, as the wallet history shows them. */
function WalletStatement({ load, queryKey, period, filtered }: {
  load: (before?: string, limit?: number, q?: PeriodQuery) => Promise<Page<WalletMovement>>; queryKey: readonly unknown[]; period: PeriodQuery; filtered: boolean;
}) {
  const pages = useCursorPages();
  const q = useQuery({ queryKey: [...queryKey, period, pages.cursor], queryFn: () => load(pages.cursor || undefined, undefined, period) });
  if (!q.data) return q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} /> : <Loading label={t('statement.loading')} />;
  if (q.data.items.length === 0 && pages.page === 1) return <Empty title={t('statement.empty')}>{filtered ? t('statement.emptyPeriod') : t('statement.walletEmpty')}</Empty>;
  return (
    <>
      <MovementsTable rows={q.data.items} />
      <CursorPager pages={pages} nextCursor={q.data.nextCursor} label={t('statement.pages')} />
    </>
  );
}
