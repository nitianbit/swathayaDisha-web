import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  EMPTY_PHARMACY_FORM, isPharmacyEmailTaken, isPharmacyPhoneTaken, PHARMACY_FIELDS, pharmacyAdminApi, pharmacyBody,
  type NewPharmacy, type PharmacyAccount, type PharmacyForm,
} from '@jansetu/api';
import { Alert, Button } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { afterFailure, beginAttempt, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { useAdminScope } from './adminScope.ts';
import { DetailFields, SignInFields } from './pharmacyFields.tsx';

/**
 * An unconfirmed pharmacy creation. The server takes no request key, so `requestKey` here is only this device's name for
 * the operation (never sent): it owns the stored state, and its body-less reload marker says one was unconfirmed.
 */
type Pending = PendingOp<{ body: NewPharmacy; draft: PharmacyForm }>;
const slotOf = (identity: string) => `pharmacy-create:${identity}`;

export const PHONE_TAKEN = 'Another pharmacy already signs in with this mobile number. Use a different number, or find that pharmacy in the list.';
export const EMAIL_TAKEN = 'Another pharmacy already uses this email. Use a different email.';

/**
 * Admin: add a pharmacy (owner decision, 19 Nov 2026: only admins create pharmacies). `POST /pharmacies` takes no request
 * key, so exactly-once is built on what the backend does guarantee: the mobile number is unique among pharmacies (a unique
 * index), so no request, resent or late, can ever make a second pharmacy with the same number.
 *
 * - The submission is stored (session memory, with a body-less reload marker) BEFORE it is sent, and sent under the page's
 *   one-at-a-time guard, so a double click or a second submit sends nothing more.
 * - A definite refusal of the only attempt unlocks the form (PHONE/EMAIL_ALREADY_EXISTS on their fields).
 * - A lost answer locks the form. The admin first checks by mobile number (the list read newest first); found with this
 *   name = it was created (open it); found under another name = the number is taken (the form unlocks with that said).
 *   Only after a check that found nothing is "Send again" offered (the same request); a resend refused as
 *   PHONE_ALREADY_EXISTS is checked the same way. "Start again" forgets it after a confirmation: safe for the same reason.
 * - After a reload nothing about it is kept on this device (no number, no name): the admin is told to look in the list.
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
  /** The attempt count a check by mobile number was made after, and found nothing: only then may it be sent again. */
  const [checkedAfter, setCheckedAfter] = useState<number | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const locked = !!pending;
  const set = <K extends keyof PharmacyForm>(k: K, v: PharmacyForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const store = (p: Pending | undefined) => {
    if (p) memory.set(slot, p); else memory.delete(slot);
    if (live.current) setPendingState(p);
  };
  /** The stored creation is still exactly `p` (same operation, same attempt) and this page is on screen. */
  const owns = (p: Pending) => live.current && stillCurrent(memory.get<Pending>(slot), p);
  /** Ends the stored creation `requestKey`, and only it. */
  const settle = (requestKey: string) => {
    resolveStored(memory, slot, requestKey);
    if (live.current) { setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined)); setCheckedAfter(null); }
  };
  const refreshList = () => queryClient.invalidateQueries({ queryKey: scopeKey });

  /**
   * What the mobile number tells about `p`: its pharmacy (created), another pharmacy (the number is taken: nothing of
   * ours can be created), or nothing yet. Acts only while `p` still owns the stored state.
   */
  async function lookUp(p: Pending): Promise<'created' | 'taken' | 'absent' | 'stale'> {
    const hit = await admin.findByPhone(p.body!.body.phone, p.firstAttemptAt);
    if (!owns(p)) return 'stale';
    if (hit && hit.name.trim() === p.body!.body.name.trim()) {
      settle(p.requestKey);
      setFound(hit);
      await refreshList();
      return 'created';
    }
    if (hit) {
      settle(p.requestKey);
      setErrors({ phone: `${hit.name} already signs in with this mobile number. Use a different number.` });
      return 'taken';
    }
    return 'absent';
  }

  /** Sends exactly `p` (same content). Only success, or a definite refusal of its first and only attempt, ends it. */
  const send = (p: Pending) => guard.perform(async () => {
    const attempt = beginAttempt(p); // stored before sending: leaving and coming back sees it as possibly running
    store(attempt);
    setError(null); setNotice(null); setCheckedAfter(null);
    try {
      const created = await admin.create(attempt.body!.body);
      if (!stillCurrent(memory.get<Pending>(slot), attempt)) return;
      settle(attempt.requestKey);
      await refreshList();
      if (live.current) void navigate(`/admin/pharmacies/${created._id}`); // only while this page is still on screen
    } catch (err) {
      if (!stillCurrent(memory.get<Pending>(slot), attempt)) return;
      // A resend refused because the number now exists: an earlier attempt may have made it. The number decides.
      if (isPharmacyPhoneTaken(err) && (attempt.attempts > 1 || attempt.uncertain)) {
        const u: Pending = { ...attempt, uncertain: true, error: messageOf(err) };
        store(u);
        try {
          // Not among the pharmacies made since the first attempt: an older one holds the number, so ours was never made.
          if (await lookUp(u) === 'absent' && owns(u)) { settle(u.requestKey); setErrors({ phone: PHONE_TAKEN }); }
        } catch (e) {
          if (owns(u)) setError(`Could not check: ${messageOf(e)}`);
        }
        return;
      }
      const next = afterFailure(attempt, err, messageOf(err));
      store(next ?? undefined);
      if (next || !live.current) return;
      // Refused, nothing created: the form unlocks with what was typed.
      if (isPharmacyPhoneTaken(err)) setErrors({ phone: PHONE_TAKEN });
      else if (isPharmacyEmailTaken(err)) setErrors({ email: EMAIL_TAKEN });
      else setError(messageOf(err));
    }
  });

  const check = (p: Pending) => guard.perform(async () => {
    setError(null); setNotice(null);
    try {
      const r = await lookUp(p);
      if (r === 'absent' && owns(p)) {
        setCheckedAfter(p.attempts);
        setNotice('No pharmacy has this mobile number yet. You can send the same request again: it can never create a second pharmacy with this number.');
      }
    } catch (err) {
      if (owns(p)) setError(`Could not check: ${messageOf(err)}`);
    }
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending || guard.running()) return; // the unconfirmed one first; one submission at a time
    const { body, errors: errs } = pharmacyBody(form, PHARMACY_FIELDS);
    setErrors(errs); setError(null); setNotice(null); setFound(null);
    if (Object.keys(errs).length) return;
    void send(startOp(newRequestKey(), { body: body as NewPharmacy, draft: form })).catch((err: unknown) => setError(messageOf(err)));
  }

  const p = pending;
  const firstOnItsWay = !!p && guard.busy && p.attempts === 1 && !p.uncertain;
  return (
    <>
      <Link className="ws-back" to="/admin/pharmacies"><ArrowLeft size={16} aria-hidden="true" /> Back to pharmacies</Link>
      <PageHeading title="Add a pharmacy">It starts as not verified: customers see it once you verify it. It signs in with its mobile number.</PageHeading>
      {found && (
        <section className="ws-section" aria-labelledby="found-h">
          <h2 id="found-h">{found.name} was created</h2>
          <p className="ws-muted">The request whose answer was lost did go through. Nothing was created twice.</p>
          <div className="ws-actions">
            <Link className="j-btn j-btn--primary" to={`/admin/pharmacies/${found._id}`}>Open {found.name}</Link>
            <Button variant="secondary" onClick={() => { setFound(null); setForm(EMPTY_PHARMACY_FORM); }}>Add another</Button>
          </div>
        </section>
      )}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {p?.restored ? (
        <section className="ws-section" aria-labelledby="unconfirmed-h">
          <h2 id="unconfirmed-h">An unconfirmed pharmacy</h2>
          <Alert tone="warn">
            Before the page reloaded, a pharmacy was being added and its answer never arrived. Its details are not kept on this device,
            so it cannot be checked or sent again from here. Look for it in the pharmacy list. Starting again is safe: a second pharmacy
            with the same mobile number is always refused.
          </Alert>
          <div className="ws-actions">
            <Link className="j-btn j-btn--secondary" to="/admin/pharmacies">Open the pharmacy list</Link>
            <Button variant="secondary" onClick={() => settle(p.requestKey)}>Start again</Button>
          </div>
        </section>
      ) : !found && (
        <form className="rx-form ws-section" noValidate onSubmit={submit}>
          {p && !firstOnItsWay && (
            <div className="confirm" role="group" aria-label="Unconfirmed pharmacy">
              <Alert tone="warn">
                {`We could not confirm whether ${p.body!.body.name} was created${p.error ? ` (${p.error})` : ''}. `}
                Check by its mobile number first: if it was created, you can open it. If not, you can send the same request again; a
                second pharmacy with the same mobile number can never be created. The form stays locked until this is settled.
              </Alert>
              {error && <Alert>{error}</Alert>}
              <div className="confirm-actions">
                <Button busy={guard.busy && checkedAfter === null} disabled={guard.busy} onClick={() => void check(p).catch(() => undefined)}>
                  Check by mobile number
                </Button>
                <Button variant="secondary" busy={guard.busy && checkedAfter !== null} disabled={guard.busy || checkedAfter !== p.attempts}
                  onClick={() => void send(p).catch(() => undefined)}>
                  Send again
                </Button>
                {checkedAfter === p.attempts && (
                  <ConfirmAction label="Start again" confirmLabel="Forget it and edit the form" disabled={guard.busy}
                    consequence={`If the earlier request still arrives, ${p.body!.body.name} is created and appears in the list. A new pharmacy with mobile number ${p.body!.body.phone} is then refused, so two can never be made.`}
                    onConfirm={async () => { if (owns(p)) settle(p.requestKey); }} />
                )}
              </div>
            </div>
          )}
          <SignInFields form={form} errors={errors} set={set} disabled={locked} />
          <DetailFields form={form} errors={errors} set={set} disabled={locked} />
          {!p && error && <Alert>{error}</Alert>}
          <div className="ws-actions">
            <Button type="submit" busy={firstOnItsWay} disabled={locked}>Add pharmacy</Button>
          </div>
        </form>
      )}
    </>
  );
}
