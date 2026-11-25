import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiError, holderRecordsApi, recordsErrorCode, type HolderRecordsGrant, type HolderRecordsRequest, type RecordsParty } from '@jansetu/api';
import { Alert, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { Confirm, PageHeading } from '../../common.tsx';
import { t } from '../../i18n/records/index.ts';
import { useCustomer, useSession } from '../../session.tsx';

/**
 * WQ28: the account holder answers doctors who ask to see their records (assisted booking round 3f, backend r30, design
 * §25.17): the waiting requests with Allow and Deny (a card on Home, and this page), who can see the records now (Stop
 * sharing), and the past requests. The server's lists are the truth: every answer, refusal or lost answer reads them again.
 * Words: the `records` catalogue; names are shown as the server sends them.
 */

const keyOf = (me: string) => ['records-access', me] as const;

function useRecords(state: 'pending' | 'all') {
  const { api } = useSession();
  const me = useCustomer();
  return useQuery({ queryKey: [...keyOf(me.id), 'requests', state], queryFn: () => holderRecordsApi(api).requests(state === 'pending' ? 'pending' : undefined) });
}

/** "Dr Asha Mehta" (a name that already starts with Dr is kept). */
function doctorName(p: RecordsParty): string {
  const name = p.doctor.name?.trim();
  if (!name) return t('doctor.unknown');
  return /^dr\.?\s/i.test(name) ? name : t('doctor.name', { name });
}

/**
 * A refusal in words: the catalogue's for its code first (WQ28b: also the 503s, `RECORDS_ACCESS_DISABLED` and
 * `INDEXES_OUTDATED`), else the server's message; no answer at all: the answer may have arrived.
 */
function refusal(err: unknown): string {
  const key = `error.${recordsErrorCode(err) ?? ''}`;
  if (t.has(key)) return t(key);
  if (err instanceof ApiError && err.status > 0 && err.status < 500) return err.message;
  return t('error.unknown');
}

/** What an answer did, said above the lists (the answered item leaves its list when the list is read again). */
export interface Note { tone: 'ok' | 'error'; text: string }

/** Allow or deny one waiting request (each behind its own second step). */
function PendingItem({ r, onAnswered }: { r: HolderRecordsRequest; onAnswered: (note: Note) => void }) {
  const { api } = useSession();
  const me = useCustomer();
  const queryClient = useQueryClient();
  const doctor = doctorName(r);
  const reread = () => queryClient.invalidateQueries({ queryKey: keyOf(me.id) });
  async function answer(decision: 'approve' | 'deny') {
    try {
      await (decision === 'approve' ? holderRecordsApi(api).approve(r._id) : holderRecordsApi(api).deny(r._id));
      onAnswered({ tone: 'ok', text: decision === 'approve' ? t('allow.done', { doctor }) : t('deny.done', { doctor }) });
    } catch (err) {
      onAnswered({ tone: 'error', text: refusal(err) });
    }
    // The server's lists are the truth (also after a refusal or a lost answer).
    await reread();
  }
  return (
    <li className="stack">
      <p>{r.patient.name ? t('pending.family', { doctor, name: r.patient.name }) : t('pending.self', { doctor })}</p>
      <p className="muted">{t('pending.when', { at: formatDateTime(r.createdAt), until: formatDateTime(r.expiresAt) })}</p>
      <div className="row">
        <Confirm label={t('allow.button')} confirmLabel={t('allow.confirm')} consequence={t('allow.consequence', { doctor })} onConfirm={() => answer('approve')} />
        <Confirm label={t('deny.button')} confirmLabel={t('deny.confirm')} consequence={t('deny.consequence', { doctor })} onConfirm={() => answer('deny')} />
      </div>
    </li>
  );
}

function PendingList({ items, onAnswered }: { items: HolderRecordsRequest[]; onAnswered: (note: Note) => void }) {
  return <ul className="stack" aria-label={t('pending.title')}>{items.map((r) => <PendingItem key={r._id} r={r} onAnswered={onAnswered} />)}</ul>;
}

/** Home: a card while a request waits for the holder's answer (nothing otherwise, also when it cannot be read). */
export function RecordsRequestsCard() {
  const q = useRecords('pending');
  const [note, setNote] = useState<Note | null>(null);
  if (!note && !q.data?.length) return null;
  return (
    <section className="card stack" aria-labelledby="records-card-h">
      <h2 id="records-card-h">{t('pending.title')}</h2>
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      {q.data?.length ? <PendingList items={q.data} onAnswered={setNote} /> : null}
      <Link to="/profile/records">{t('home.more')}</Link>
    </section>
  );
}

/** Profile: the link to the page. */
export function RecordsLink() {
  return <Link to="/profile/records">{t('profile.link')}</Link>;
}

/** `/profile/records`: what waits for an answer, who can see the records now, and the past requests. */
export function RecordsScreen() {
  const pending = useRecords('pending');
  const all = useRecords('all');
  const [note, setNote] = useState<Note | null>(null);
  return (
    <>
      <PageHeading title={t('page.title')}>{t('page.intro')}</PageHeading>
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <section className="card stack" aria-labelledby="records-pending-h">
        <h2 id="records-pending-h">{t('pending.title')}</h2>
        {pending.isPending ? <Loading />
          : pending.isError ? <ErrorState message={t('error.load')} onRetry={() => void pending.refetch()} />
          : pending.data.length === 0 ? <p className="muted">{t('pending.none')}</p>
          : <PendingList items={pending.data} onAnswered={setNote} />}
      </section>
      <Grants onRevoked={setNote} />
      <section className="card stack" aria-labelledby="records-history-h">
        <h2 id="records-history-h">{t('history.title')}</h2>
        {all.isPending ? <Loading />
          : all.isError ? <ErrorState message={t('error.load')} onRetry={() => void all.refetch()} />
          : <History items={all.data.filter((r) => r.state !== 'pending')} />}
      </section>
    </>
  );
}

function History({ items }: { items: HolderRecordsRequest[] }) {
  if (items.length === 0) return <p className="muted">{t('history.none')}</p>;
  const outcome = (r: HolderRecordsRequest) => {
    const at = formatDateTime(r.decidedAt ?? r.createdAt);
    if (r.state === 'approved') return t('history.approved', { at });
    if (r.state === 'denied') return t('history.denied', { at });
    return r.state === 'replaced' ? t('history.replaced') : t('history.expired');
  };
  return (
    <ul className="stack" aria-label={t('history.title')}>
      {items.map((r) => {
        const doctor = doctorName(r);
        return (
          <li key={r._id}>
            <strong>{r.patient.name ? t('history.family', { doctor, name: r.patient.name }) : t('history.self', { doctor })}</strong>
            <div className="muted">{outcome(r)}</div>
          </li>
        );
      })}
    </ul>
  );
}

/** Who can see the records now (active grants), each with "Stop sharing". */
function Grants({ onRevoked }: { onRevoked: (note: Note) => void }) {
  const { api } = useSession();
  const me = useCustomer();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: [...keyOf(me.id), 'grants'], queryFn: () => holderRecordsApi(api).grants() });
  const active = (q.data ?? []).filter((g) => g.state === 'active');
  async function revoke(g: HolderRecordsGrant) {
    try {
      await holderRecordsApi(api).revoke(g._id);
      onRevoked({ tone: 'ok', text: t('revoke.done', { doctor: doctorName(g) }) });
    } catch (err) {
      onRevoked({ tone: 'error', text: refusal(err) });
    }
    await queryClient.invalidateQueries({ queryKey: keyOf(me.id) });
  }
  return (
    <section className="card stack" aria-labelledby="records-grants-h">
      <h2 id="records-grants-h">{t('grants.title')}</h2>
      {q.isPending ? <Loading />
        : q.isError ? <ErrorState message={t('error.load')} onRetry={() => void q.refetch()} />
        : active.length === 0 ? <Empty title={t('grants.none')} />
        : (
          <ul className="stack" aria-label={t('grants.title')}>
            {active.map((g) => {
              const doctor = doctorName(g);
              const until = formatDateTime(g.expiresAt);
              return (
                <li key={g._id} className="stack">
                  <p>{g.patient.name ? t('grants.family', { doctor, name: g.patient.name, until }) : t('grants.self', { doctor, until })}</p>
                  <Confirm label={t('revoke.button')} confirmLabel={t('revoke.confirm')} consequence={t('revoke.consequence', { doctor })} onConfirm={() => revoke(g)} />
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
