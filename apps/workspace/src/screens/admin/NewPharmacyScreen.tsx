import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  EMPTY_PHARMACY_FORM, isPharmacyEmailTaken, isPharmacyPhoneTaken, PHARMACY_FIELDS, pharmacyAdminApi, pharmacyBody,
  type NewPharmacy, type PharmacyAccount, type PharmacyForm,
} from '@jansetu/api';
import { Alert, Button, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { afterFailure, beginAttempt, newRequestKey, ownsKey, resolveStored, startOp, stillCurrent, wasAbandoned, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { useAdminScope } from './adminScope.ts';
import { DetailFields, SignInFields } from './pharmacyFields.tsx';

/** An unconfirmed pharmacy creation: the request key it is sent with (Q15) and what was typed. */
type Pending = PendingOp<{ body: NewPharmacy; draft: PharmacyForm }>;
const slotOf = (identity: string) => `pharmacy-create:${identity}`;

/**
 * Admin: add a pharmacy (owner decision, 19 Nov 2026: only admins create pharmacies). Q15: `POST /pharmacies` is exactly
 * once per (admin, request key), the same owned-PendingOp / by-key pattern as adding a lab or clinic:
 *
 * - A key is made per submitted form and stored with the exact request (session memory, plus a body-less reload marker)
 *   BEFORE it is sent, under the page's one-at-a-time guard, so a double click or a second submit sends nothing more.
 * - A definite refusal of the only attempt unlocks the form (PHONE/EMAIL_ALREADY_EXISTS on their fields; the pharmacy
 *   holding the number is named, found with the exact `phone` filter).
 * - A lost answer locks the form: "Send again" resends the same key and details (the server answers with the pharmacy it
 *   already made, `replayed`), or "Give up this create" abandons the key on the server (then it can never create one;
 *   if it already had, that pharmacy is opened).
 * - After a reload only the key is known: it is looked up (`GET /pharmacies/by-key/:key`), never guessed from the list.
 * - An answer settles the stored creation only while this page is on screen and the attempt still owns it.
 */
export function NewPharmacyScreen() {
  const scope = useAdminScope('pharmacies');
  return <NewPharmacy key={scope.identity} identity={scope.identity} scopeKey={scope.key} />;
}

function NewPharmacy({ identity, scopeKey }: { identity: string; scopeKey: readonly string[] }) {
  const { api, memory } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const admin = pharmacyAdminApi(api);
  const slot = slotOf(identity);
  const guard = useOneAtATime('pharmacy');
  const [pending, setPendingState] = useState<Pending | undefined>(() => memory.get<Pending>(slot));
  const [form, setForm] = useState<PharmacyForm>(() => memory.get<Pending>(slot)?.body?.draft ?? EMPTY_PHARMACY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof PharmacyForm, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [found, setFound] = useState<PharmacyAccount | null>(null);
  /** The pharmacy that already signs in with the number typed (after a PHONE_ALREADY_EXISTS refusal). */
  const [holder, setHolder] = useState<PharmacyAccount | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const locked = !!pending;
  const set = <K extends keyof PharmacyForm>(k: K, v: PharmacyForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const store = (p: Pending | undefined) => {
    if (p) memory.set(slot, p); else memory.delete(slot);
    if (live.current) setPendingState(p);
  };
  /**
   * WQ11b: an answer about the key itself (a give-up's `used`/`abandoned`, a by-key lookup) settles what this page shows
   * when the stored creation is this key or is gone: after leaving mid-send and coming back, the first page's late answer
   * removes the stored creation while this page still shows it (and "Give up" must not then do nothing).
   */
  const ownsTheKey = (p: Pending) => live.current && ownsKey(memory.get<Pending>(slot), p.requestKey);
  /** Ends the stored creation `requestKey`, and only it. */
  const settle = (requestKey: string) => {
    resolveStored(memory, slot, requestKey);
    if (live.current) setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
  };
  const open = async (id: string) => {
    await queryClient.invalidateQueries({ queryKey: scopeKey });
    if (live.current) void navigate(`/admin/pharmacies/${id}`); // only while this page is still the one on screen
  };

  // After a reload: what did the stored key make? (A body-less marker: nothing can be resent.)
  const restoredKey = pending?.restored ? pending.requestKey : null;
  const lookup = useQuery({
    queryKey: [...scopeKey, 'by-key', restoredKey],
    queryFn: () => admin.createdByKey(restoredKey!),
    enabled: !!restoredKey,
  });
  useEffect(() => {
    // Only for the restored creation this page shows (a cached answer for another key or a newer state is ignored).
    if (restoredKey && lookup.data && pending?.requestKey === restoredKey && ownsTheKey(pending)) {
      setFound(lookup.data);
      settle(restoredKey);
    }
  }, [restoredKey, lookup.data, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Names the pharmacy holding `phone` (exact lookup), for the refusal on the field. Best effort. */
  async function nameHolder(phone: string) {
    try {
      const h = await admin.findByPhone(phone);
      if (!live.current) return;
      setHolder(h);
      if (h) setErrors({ phone: t('newPharmacy.holderTaken', { name: h.name }) });
    } catch { /* the general refusal stays */ }
  }

  /** Sends exactly `p` (same key, same content). Only success, or a definite refusal of its first attempt, ends it. */
  const send = (p: Pending) => guard.perform(async () => {
    const attempt = beginAttempt(p); // stored before sending: leaving and coming back sees it as possibly running
    store(attempt);
    setError(null); setNotice(null); setHolder(null);
    try {
      const { pharmacy } = await admin.create(attempt.body.body, attempt.requestKey);
      // A newer attempt (or a give-up) owns the outcome now; this older answer changes nothing.
      if (!stillCurrent(memory.get<Pending>(slot), attempt)) return;
      settle(attempt.requestKey);
      await open(pharmacy._id);
    } catch (err) {
      if (!stillCurrent(memory.get<Pending>(slot), attempt)) return;
      // The key was given up (e.g. in another tab): nothing was or can ever be created with it.
      if (wasAbandoned(err)) {
        settle(attempt.requestKey);
        if (live.current) setError(t('newPharmacy.givenUpEarlier'));
        return;
      }
      const next = afterFailure(attempt, err, messageOf(err));
      store(next ?? undefined);
      if (next || !live.current) return;
      // Refused, nothing created: the form unlocks with what was typed.
      if (isPharmacyPhoneTaken(err)) { setErrors({ phone: t('pharmacy.phoneTaken') }); void nameHolder(attempt.body.body.phone); }
      else if (isPharmacyEmailTaken(err)) setErrors({ email: t('pharmacy.emailTaken') });
      else setError(messageOf(err));
    }
  });

  /** Q15: makes sure the key can never create a pharmacy ('abandoned'), or learns that it did ('used'). */
  const giveUp = (p: Pending) => guard.perform(async () => {
    setError(null); setNotice(null);
    try {
      const r = await admin.abandonCreate(p.requestKey);
      // Left page, or another creation stored since: this answer settles and opens nothing. (The same key settled by a
      // page left earlier is still this page's to show: the server's word on the key decides.)
      if (!ownsTheKey(p)) return;
      settle(p.requestKey);
      if (r.state === 'used') {
        if (r.pharmacy) { await open(r.pharmacy._id); return; }
        setNotice(t('newPharmacy.alreadyCreated'));
        return;
      }
      if (p.restored) setForm(EMPTY_PHARMACY_FORM);
      setNotice(t('newPharmacy.givenUp'));
    } catch (err) {
      if (ownsTheKey(p)) setError(messageOf(err));
    }
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending || guard.running()) return; // the unconfirmed one first; one submission at a time
    const { body, errors: errs } = pharmacyBody(form, PHARMACY_FIELDS);
    setErrors(errs); setError(null); setNotice(null); setFound(null); setHolder(null);
    if (Object.keys(errs).length) return;
    void send(startOp(newRequestKey(), { body: body as NewPharmacy, draft: form })).catch((err: unknown) => setError(messageOf(err)));
  }

  const p = pending;
  const firstOnItsWay = !!p && guard.busy && p.attempts === 1 && !p.uncertain;
  return (
    <>
      <Link className="ws-back" to="/admin/pharmacies"><ArrowLeft size={16} aria-hidden="true" /> {t('common.backToPharmacies')}</Link>
      <PageHeading title={t('pharmacies.add')}>{t('newPharmacy.intro')}</PageHeading>
      {found && (
        <section className="ws-section" aria-labelledby="found-h">
          <h2 id="found-h">{t('newPharmacy.created', { name: found.name })}</h2>
          <p className="ws-muted">{t('newPharmacy.createdOnce')}</p>
          <div className="ws-actions">
            <Link className="j-btn j-btn--primary" to={`/admin/pharmacies/${found._id}`}>{t('newPharmacy.open', { name: found.name })}</Link>
            <Button variant="secondary" onClick={() => { setFound(null); setForm(EMPTY_PHARMACY_FORM); }}>{t('newPharmacy.addAnother')}</Button>
          </div>
        </section>
      )}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {p?.restored ? (
        <section className="ws-section" aria-labelledby="unconfirmed-h">
          <h2 id="unconfirmed-h">{t('newPharmacy.restored.title')}</h2>
          {lookup.isPending ? <Loading label={t('newPharmacy.restored.checking')} />
            : lookup.isError ? <ErrorState message={messageOf(lookup.error)} onRetry={() => void lookup.refetch()} />
            : (
              <>
                <Alert tone="warn">{t('newPharmacy.restored.text')}</Alert>
                {error && <Alert>{error}</Alert>}
                <div className="ws-actions">
                  <Button busy={guard.busy} onClick={() => void giveUp(p).catch((err: unknown) => setError(messageOf(err)))}>{t('newPharmacy.giveUp')}</Button>
                  <Button variant="secondary" disabled={guard.busy || lookup.isFetching} onClick={() => void lookup.refetch()}>{t('newPharmacy.checkAgain')}</Button>
                </div>
              </>
            )}
        </section>
      ) : !found && (
        <form className="rx-form ws-section" noValidate onSubmit={submit}>
          {p && !firstOnItsWay && (
            <div className="confirm" role="group" aria-label={t('newPharmacy.unconfirmed.label')}>
              <Alert tone="warn">
                {p.error ? t('newPharmacy.unconfirmed.leadError', { name: p.body.body.name, error: p.error })
                  : t('newPharmacy.unconfirmed.lead', { name: p.body.body.name })}
                {' '}{t('newPharmacy.unconfirmed.next')}
              </Alert>
              {error && <Alert>{error}</Alert>}
              <div className="confirm-actions">
                <Button busy={guard.busy} onClick={() => void send(p).catch((err: unknown) => setError(messageOf(err)))}>{t('newPharmacy.sendAgain')}</Button>
                <Button variant="secondary" disabled={guard.busy} onClick={() => void giveUp(p).catch((err: unknown) => setError(messageOf(err)))}>
                  {t('newPharmacy.giveUp')}
                </Button>
              </div>
            </div>
          )}
          <SignInFields form={form} errors={errors} set={set} disabled={locked} />
          {holder && <p><Link to={`/admin/pharmacies/${holder._id}`}>{t('newPharmacy.open', { name: holder.name })}</Link></p>}
          <DetailFields form={form} errors={errors} set={set} disabled={locked} />
          {!p && error && <Alert>{error}</Alert>}
          <div className="ws-actions">
            <Button type="submit" busy={firstOnItsWay} disabled={locked}>{t('newPharmacy.submit')}</Button>
          </div>
        </form>
      )}
    </>
  );
}
