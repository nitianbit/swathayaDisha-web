import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  adminOwnerWalletApi, asPharmacyWallet, doctorAdminListApi, OBJECT_ID_PATTERN, ownerWalletRefusal, partnerAdminApi, type LabWalletLot, type Refusal,
  type WalletOwnerKind,
} from '@jansetu/api';
import { Alert, Badge, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { CursorPager, useCursorPages } from '../pharmacy/cursorList.tsx';
import { WalletHistory } from '../pharmacy/WalletScreen.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { NoSuchRecord } from './accountList.tsx';
import { useAdminScope } from './adminScope.ts';
import { AddMoney, Balance, UncreditedTopups, type AdminTopupTarget } from './PharmacyWalletsScreen.tsx';

/**
 * WQ20 admin: one lab's Jansetu wallet (r13, `/admin/labs/:partnerId/wallet*`); WQ23: one doctor's the same way (r20,
 * `/admin/doctors/:specialistId/wallet*`). On the admin pharmacy wallet's own pieces: the balance, its hold (`PUT …/freeze`),
 * money added by an admin (`POST …/topup`, Idempotency-Key, at most ₹2,00,000, exact by-key read), the history, the card
 * top-ups (lots) with the existing chargeback (flag only for both), and the card top-ups not credited with the existing
 * "already paid by hand" close.
 */
export function LabWalletAdminScreen() {
  const { partnerId = '' } = useParams();
  const scope = useAdminScope('lab-wallets');
  if (!OBJECT_ID_PATTERN.test(partnerId)) return (
    <NoSuchRecord back="/admin/partners" backLabel={t('common.backToPartners')} title={t('labWallet.lab')} missing={t('labWallet.noSuchLab')}>
      {t('labWallet.openFromList')}
    </NoSuchRecord>
  );
  return <OwnerWallet key={`${scope.identity}:${partnerId}`} kind="lab" scopeKey={scope.key} ownerId={partnerId.toLowerCase()} />;
}

/** WQ23: `/admin/doctors/:doctorId/wallet`, linked from the doctor's admin page (WQ18). */
export function DoctorWalletAdminScreen() {
  const { doctorId = '' } = useParams();
  const scope = useAdminScope('doctor-wallets');
  if (!OBJECT_ID_PATTERN.test(doctorId)) return (
    <NoSuchRecord back="/admin/doctors" backLabel={t('common.backToDoctors')} title={t('doctorWallet.doctor')} missing={t('doctorWallet.noSuchDoctor')}>
      {t('doctorWallet.openFromList')}
    </NoSuchRecord>
  );
  return <OwnerWallet key={`${scope.identity}:${doctorId}`} kind="doctor" scopeKey={scope.key} ownerId={doctorId.toLowerCase()} />;
}

/** One owner's admin wallet routes and its words, made once on the page and handed to its parts. */
interface OwnerTools { w: ReturnType<typeof adminOwnerWalletApi>; refusal: (err: unknown) => Refusal }

/** An owner's wallet as the admin credit's target (the shared Add money form). */
function ownerTarget({ w }: OwnerTools, kind: WalletOwnerKind, scopeKey: readonly string[], ownerId: string, name: string): AdminTopupTarget {
  return {
    ownerKey: `${kind}-${ownerId}`, ownerName: name, owner: kind, queryKey: [...scopeKey, ownerId], recentKey: [...scopeKey, ownerId, 'entries', 'recent'],
    recent: () => w.entries(ownerId),
    topup: async (body, key) => asPharmacyWallet(await w.topup(ownerId, { amountMinor: body.amount * 100, notes: body.notes }, key)),
    findCredit: async (key) => {
      const exact = await w.topupByKey(ownerId, key);
      return exact.state === 'used' ? { row: exact.row } : { row: null, complete: true, searched: 0, exact: true };
    },
  };
}

function OwnerWallet({ kind, scopeKey, ownerId }: { kind: WalletOwnerKind; scopeKey: readonly string[]; ownerId: string }) {
  const { api } = useSession();
  const w = adminOwnerWalletApi(api, kind);
  const tools: OwnerTools = { w, refusal: (err) => ownerWalletRefusal(err, kind) };
  const owner = useQuery({
    queryKey: [...scopeKey, ownerId, kind],
    queryFn: async () => (kind === 'lab' ? partnerAdminApi(api).get(ownerId) : doctorAdminListApi(api).get(ownerId)),
  });
  const wallet = useQuery({ queryKey: [...scopeKey, ownerId, 'wallet'], queryFn: () => w.wallet(ownerId) });
  const history = useCursorPages();
  const entries = useQuery({ queryKey: [...scopeKey, ownerId, 'entries', history.cursor], queryFn: () => w.entries(ownerId, history.cursor || undefined) });
  const name = owner.data?.name ?? (kind === 'lab' ? t('labWallet.thisLab') : t('doctorWallet.thisDoctor'));
  const view = wallet.data ? asPharmacyWallet(wallet.data) : null;
  const back = kind === 'lab' ? `/admin/partners/${ownerId}` : `/admin/doctors/${ownerId}`;
  return (
    <>
      <Link className="ws-back" to={back}><ArrowLeft size={16} aria-hidden="true" />{' '}
        {owner.data?.name != null ? t('labWallet.backTo', { name: owner.data.name }) : kind === 'lab' ? t('labWallet.backToLab') : t('doctorWallet.backToDoctor')}
      </Link>
      <PageHeading title={owner.data ? t('adminWallet.titleNamed', { name: owner.data.name }) : kind === 'lab' ? t('labWallet.title') : t('doctorWallet.title')} />
      <section className="ws-section" aria-labelledby="bal-h">
        <h2 id="bal-h">{t('adminWallet.balance')}</h2>
        {wallet.isPending ? <Loading label={t('adminWallet.loadingWallet')} />
          : wallet.isError ? <ErrorState message={tools.refusal(wallet.error).message} onRetry={() => void wallet.refetch()} />
          : (
            <>
              <Balance w={wallet.data.exists === false ? null : view} owner={kind} />
              <Hold tools={tools} scopeKey={scopeKey} ownerId={ownerId} name={name} frozen={wallet.data.frozen} />
            </>
          )}
      </section>
      <section className="ws-section" aria-labelledby="add-h">
        <h2 id="add-h">{t('adminWallet.addMoney')}</h2>
        {owner.data && wallet.isSuccess ? <AddMoney target={ownerTarget(tools, kind, scopeKey, ownerId, owner.data.name)} wallet={view} />
          : owner.isPending || wallet.isPending ? <Loading label={t('adminWallet.loading')} /> : <p className="ws-muted">{t(`adminWallet.mustLoad.${kind}`)}</p>}
      </section>
      <WalletHistory q={entries} notes empty={t('labWallet.historyEmpty', { name })} first={history.page === 1}
        pager={<CursorPager pages={history} nextCursor={entries.data?.nextCursor} label={t('adminWallet.historyPages')} />} />
      <Lots tools={tools} scopeKey={scopeKey} ownerId={ownerId} />
      <section className="ws-section" aria-labelledby="uncredited-h">
        <h2 id="uncredited-h">{t('adminWallet.uncredited')}</h2>
        <UncreditedTopups scopeKey={scopeKey} ownerId={ownerId} ownerName={name} owner={kind} />
      </section>
    </>
  );
}

/**
 * Put the wallet on hold (it cannot pay; money can still be added) or release it, with a reason. Setting a state twice
 * changes nothing more, so a lost answer is settled by reading the wallet again.
 */
function Hold({ tools: { w, refusal }, scopeKey, ownerId, name, frozen }: { tools: OwnerTools; scopeKey: readonly string[]; ownerId: string; name: string; frozen: boolean }) {
  const queryClient = useQueryClient();
  const { perform, busy } = useOneAtATime('wallet');
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const say = (tone: 'ok' | 'warn' | 'error', text: string) => { if (live.current) setOutcome({ tone, text }); };
  const act = (to: boolean, reason: string) => perform(async () => {
    setOutcome(null);
    const done = to ? t('labWallet.hold.on', { name }) : t('labWallet.hold.released', { name });
    try {
      await w.freeze(ownerId, to, reason);
      say('ok', done);
    } catch (err) {
      if (definitelyNotRecorded(err)) say('error', t('labWallet.hold.notChanged', { message: refusal(err).message }));
      else {
        const now = await w.wallet(ownerId).catch(() => null);
        if (now && now.frozen === to) say('ok', done);
        else say('warn', t('labWallet.hold.notConfirmed', { message: refusal(err).message }));
      }
    } finally {
      await queryClient.invalidateQueries({ queryKey: [...scopeKey, ownerId] });
    }
  });
  return (
    <>
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      <div className="ws-actions">
        {frozen ? (
          <ConfirmAction key="release" label={t('labWallet.hold.release')} confirmLabel={t('labWallet.hold.releaseConfirm')} reason
            reasonLabel={t('labWallet.hold.releaseWhy')} disabled={busy}
            consequence={t('labWallet.hold.releaseConsequence', { name })} onConfirm={(reason) => act(false, reason)} />
        ) : (
          <ConfirmAction key="hold" label={t('labWallet.hold.put')} danger confirmLabel={t('labWallet.hold.putConfirm')} reason
            reasonLabel={t('labWallet.hold.putWhy')} disabled={busy}
            consequence={t('labWallet.hold.putConsequence', { name })} onConfirm={(reason) => act(true, reason)} />
        )}
      </div>
    </>
  );
}

/** A lot's dispute state in words (`labWallet.dispute.<state>`), or nothing for a state without words. */
const disputeWords = (state: string) => { const key = `labWallet.dispute.${state}`; return t.has(key) ? t(key) : null; };

/**
 * The card top-ups as lots (newest first, at most 200). The existing chargeback of a lot
 * (`POST /admin/wallet-lots/:lotId/chargeback`): for a lab or a doctor it only flags the top-up (no money is taken; the lot stops being
 * withdrawable; recovering the money is an admin decision). Repeating it answers the flag again.
 */
function Lots({ tools: { w, refusal }, scopeKey, ownerId }: { tools: OwnerTools; scopeKey: readonly string[]; ownerId: string }) {
  const queryClient = useQueryClient();
  const lots = useQuery({ queryKey: [...scopeKey, ownerId, 'lots'], queryFn: () => w.lots(ownerId) });
  const { perform, busy } = useOneAtATime('lot');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const dispute = (lot: LabWalletLot, reason: string) => perform(async () => {
    setNotice(null);
    try {
      const r = await w.chargebackLot(lot._id, reason);
      setNotice({ tone: 'ok', text: r.replayed ? t('labWallet.lots.replayed')
        : t('labWallet.lots.recorded', { amount: formatRupees(lot.amountMinor / 100) }) });
    } catch (err) {
      if (definitelyNotRecorded(err)) setNotice({ tone: 'error', text: t('labWallet.lots.notRecorded', { message: refusal(err).message }) });
      else setNotice({ tone: 'warn', text: t('labWallet.lots.notConfirmed', { message: refusal(err).message }) });
    } finally {
      await queryClient.invalidateQueries({ queryKey: [...scopeKey, ownerId] });
    }
  });
  return (
    <section className="ws-section" aria-labelledby="lots-h">
      <h2 id="lots-h">{t('labWallet.lots.title')}</h2>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {lots.isPending ? <Loading label={t('adminWallet.loadingTopups')} />
        : lots.isError ? <ErrorState message={refusal(lots.error).message} onRetry={() => void lots.refetch()} />
        : lots.data.length === 0 ? <p className="ws-muted">{t('labWallet.lots.empty')}</p>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('labWallet.lots.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('labWallet.lots.col.paid')}</th><th scope="col">{t('common.amount')}</th><th scope="col">{t('labWallet.lots.col.left')}</th>
                  <th scope="col">{t('adminWallet.col.state')}</th><th scope="col"><span className="j-sr-only">{t('labWallet.lots.col.dispute')}</span></th>
                </tr>
              </thead>
              <tbody>
                {lots.data.map((l) => (
                  <tr key={l._id}>
                    <td>{formatDateTime(l.createdAt)}</td>
                    <td>{formatRupees(l.amountMinor / 100)}</td>
                    <td>{formatRupees(l.remainingMinor / 100)}</td>
                    <td>{l.disputeState && disputeWords(l.disputeState) ? <Badge tone="danger">{disputeWords(l.disputeState)}</Badge> : l.closed ? t('labWallet.lots.usedUp') : '—'}</td>
                    <td>
                      {l.disputeState !== 'lost' && (
                        <ConfirmAction label={t('labWallet.lots.record')} danger reason reasonLabel={t('labWallet.lots.recordWhy')}
                          confirmLabel={t('labWallet.lots.recordConfirm')} disabled={busy}
                          consequence={t('labWallet.lots.recordConsequence', { amount: formatRupees(l.amountMinor / 100), date: formatDateTime(l.createdAt) })}
                          onConfirm={(reason) => dispute(l, reason)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
