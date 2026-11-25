import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  MAX_REFERRAL_REASON, OBJECT_ID_PATTERN, partnerAdminApi, pharmacyAdminApi, REFERRAL_CATEGORIES, REFERRAL_CATEGORY_LABEL, REFERRAL_RULE_REFUSAL, referralDraftOf, referralRuleRefusal,
  referralRuleRefusedBeforeWriting, referralRulesAdminApi, referralRuleText, referralTermsOf, referralTermsText, sameRuleTerms,
  type ReferralBookerKind, type ReferralCategory, type ReferralDraft, type ReferralRule, type ReferralRuleEvent, type ReferralTerms,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { isRecordChanged } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession, useStaff } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { NoSuchRecord } from './accountList.tsx';
import { useAdminScope } from './adminScope.ts';

/**
 * WQ26 admin: a pharmacy's or a lab's referral cuts (phase 4a, `/admin/referral-rules`): one row per category with the
 * rule as saved and Edit, the master switch when the rules show it is off, and the history. A change is confirmed with a
 * reason and sent with the version it was made from (`expectedVersion`, 0 = create): 409 RECORD_CHANGED means someone
 * else saved first, so nothing was saved and the rules are read again.
 */
export function PharmacyReferralCutsScreen() {
  const { pharmacyId = '' } = useParams();
  const scope = useAdminScope('referral-cuts');
  if (!OBJECT_ID_PATTERN.test(pharmacyId)) return <NoSuchRecord back="/admin/pharmacies" backLabel="Back to pharmacies" title="Referral cuts">Open it from the pharmacy’s page.</NoSuchRecord>;
  return <ReferralCuts key={`${scope.identity}:pharmacy:${pharmacyId}`} kind="pharmacy" bookerId={pharmacyId.toLowerCase()} scopeKey={scope.key} />;
}

/** `/admin/partners/:partnerId/referral-cuts`, linked from a lab's admin page (clinics book no patients for others). */
export function LabReferralCutsScreen() {
  const { partnerId = '' } = useParams();
  const scope = useAdminScope('referral-cuts');
  if (!OBJECT_ID_PATTERN.test(partnerId)) return <NoSuchRecord back="/admin/partners" backLabel="Back to labs and clinics" title="Referral cuts">Open it from the lab’s page.</NoSuchRecord>;
  return <ReferralCuts key={`${scope.identity}:lab:${partnerId}`} kind="lab" bookerId={partnerId.toLowerCase()} scopeKey={scope.key} />;
}

interface Booker { name: string; cuts: boolean }

function ReferralCuts({ kind, bookerId, scopeKey }: { kind: ReferralBookerKind; bookerId: string; scopeKey: readonly string[] }) {
  const { api } = useSession();
  const key = [...scopeKey, kind, bookerId];
  const booker = useQuery({
    queryKey: [...key, 'booker'],
    queryFn: async (): Promise<Booker> => {
      if (kind === 'pharmacy') return { name: (await pharmacyAdminApi(api).get(bookerId)).name, cuts: true };
      const p = await partnerAdminApi(api).get(bookerId);
      return { name: p.name, cuts: p.kind === 'lab' };
    },
  });
  const name = booker.data?.name;
  const back = kind === 'pharmacy' ? `/admin/pharmacies/${bookerId}` : `/admin/partners/${bookerId}`;
  return (
    <>
      <Link className="ws-back" to={back}><ArrowLeft size={16} aria-hidden="true" /> Back to {name ?? (kind === 'pharmacy' ? 'the pharmacy' : 'the lab')}</Link>
      <PageHeading title={name ? `Referral cuts: ${name}` : 'Referral cuts'}>
        What {name ?? 'this partner'} earns for each booking it makes for a patient. The cut is taken from the doctor’s or the lab’s earning, after any coupon.
      </PageHeading>
      {booker.isPending ? <Loading label="Loading…" />
        : booker.isError ? <ErrorState message={messageOf(booker.error)} onRetry={() => void booker.refetch()} />
        : !booker.data.cuts ? <Empty title="No referral cuts for clinics">Referral cuts are set for pharmacies and labs, the partners that book for patients.</Empty>
        : (
          <>
            <Rules kind={kind} bookerId={bookerId} name={booker.data.name} pageKey={key} />
            <History kind={kind} bookerId={bookerId} queryKey={[...key, 'events']} />
          </>
        )}
    </>
  );
}

/** A rule change kept until its answer is known (`terms` and `expectedVersion` are what the admin confirmed). */
interface RuleChange { category: ReferralCategory; terms: ReferralTerms; expectedVersion: number; reason: string }

const catWord = (c: ReferralCategory) => REFERRAL_CATEGORY_LABEL[c].toLowerCase();
const providerWord = (c: ReferralCategory) => (c === 'consultation' ? 'doctor’s' : 'lab’s');

/**
 * The rules table and one editor at a time, sent with an owned PendingOp (stored before sending; an answer settles it only
 * while this page is on screen and the attempt still owns it). A lost answer is checked by reading the rules: a version
 * past the one the change was made from means it was saved (same terms) or overtaken; the same version means not saved
 * yet, and sending it again is safe (the version fence lets at most one attempt through).
 */
function Rules({ kind, bookerId, name, pageKey }: { kind: ReferralBookerKind; bookerId: string; name: string; pageKey: readonly unknown[] }) {
  const { api } = useSession();
  const admin = useStaff();
  const queryClient = useQueryClient();
  const rulesApi = referralRulesAdminApi(api);
  const rulesKey = [...pageKey, 'rules'];
  const rules = useQuery({ queryKey: rulesKey, queryFn: () => rulesApi.list(kind, bookerId) });
  const guard = useOneAtATime('referral cut');
  const { op, send, settle } = useOwnedOp<RuleChange>(`admin-referral-rule:${admin.id}:${kind}:${bookerId}`);
  const [editing, setEditing] = useState<{ category: ReferralCategory; base: ReferralRule | null } | null>(null);
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const say = (tone: 'ok' | 'warn' | 'error', text: string) => { if (live.current) setOutcome({ tone, text }); };
  /** The server's rules decide: read again after every answer (the history too). */
  const reread = () => queryClient.invalidateQueries({ queryKey: pageKey });
  const readNow = async () => {
    const fresh = await rulesApi.list(kind, bookerId);
    queryClient.setQueryData(rulesKey, fresh);
    return fresh.rules;
  };
  const ruleOf = (list: readonly ReferralRule[] | undefined, c: ReferralCategory) => list?.find((r) => r.category === c) ?? null;
  const savedWords = (c: ReferralCategory, r: ReferralRule | null) => {
    const t = referralRuleText(r);
    return `Saved: the ${catWord(c)} cut of ${name} is ${t === 'Off' ? 'off' : t} (version ${r?.version ?? 0}).`;
  };
  /** `sentBefore`: an earlier attempt may have been saved and then changed again, so it is not said that it was not saved. */
  const overtakenWords = (c: ReferralCategory, r: ReferralRule | null, sentBefore = false) => (sentBefore
    ? `The ${catWord(c)} cut is not what you sent: it was changed since. Saved now: ${referralRuleText(r)} (version ${r?.version ?? 0}). Check it, then make your change again if it is still needed.`
    : `The ${catWord(c)} cut was changed by someone else meanwhile, so your change was not saved. Saved now: ${referralRuleText(r)} (version ${r?.version ?? 0}). Check it, then save again if your change is still needed.`);

  /**
   * 409 RECORD_CHANGED: this attempt wrote nothing. The rules as read now tell the rest: for a change already sent before
   * (uncertain), a newer version with the same terms is the change itself; anything else was someone else's.
   */
  async function afterConflict(p: PendingOp<RuleChange>, uncertain: boolean) {
    const now = await readNow().catch(() => null);
    if (!now) {
      // Uncertain: it stays unconfirmed (below) until a check can read the cuts.
      if (!uncertain) say('warn', `${REFERRAL_RULE_REFUSAL.RECORD_CHANGED} The cuts could not be read again: reload the page before saving again.`);
      return;
    }
    const r = ruleOf(now, p.body.category);
    if (uncertain) settle(p.requestKey);
    if (uncertain && r && r.version > p.body.expectedVersion && sameRuleTerms(r, p.body.terms)) {
      say('ok', savedWords(p.body.category, r));
      if (live.current) setEditing(null);
      return;
    }
    say('warn', overtakenWords(p.body.category, r, uncertain));
    // The editor stays open with what was typed, now made from the version saved now.
    if (live.current) setEditing((e) => (e && e.category === p.body.category ? { category: e.category, base: r } : e));
  }

  async function change(p: PendingOp<RuleChange>) {
    setOutcome(null);
    setResendError(null);
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await guard.perform(() => send(p, (b) => rulesApi.put(kind, bookerId, b.category, b.terms, b.expectedVersion, b.reason)));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      say('ok', savedWords(p.body.category, r.value));
      if (live.current) setEditing(null);
    } else if (isRecordChanged(r.error)) {
      await afterConflict(p, r.kind === 'unknown');
    } else if (r.kind === 'refused' || (sole && referralRuleRefusedBeforeWriting(r.error))) {
      // The only attempt was refused, or refused before anything was written (switch off, indexes): nothing was saved.
      if (r.kind === 'unknown') settle(p.requestKey);
      say('error', `Not saved: ${referralRuleRefusal(r.error)}`);
    } else if (live.current) {
      // No answer: the change is kept as unconfirmed (below) until it is checked.
      setEditing(null);
    }
    void reread();
  }

  const pending = op && !(guard.busy && op.attempts === 1 && !op.uncertain) ? op : undefined;
  // r33: the server says whether REFERRAL_CUTS_ENABLED is on (null from a server that does not say: no note).
  const on = rules.data?.switches?.cutsEnabled ?? null;
  return (
    <section className="ws-section" aria-labelledby="rc-h">
      <h2 id="rc-h">Cuts by category</h2>
      <p className="ws-muted">
        A percent is of each line (0.01% to 50%, with an optional cap per line); a fixed amount is per line, with no upper limit. A change applies to bookings
        made after it; bookings already made keep their cut. Payouts of these earnings are paused until Jansetu switches them on.
      </p>
      {on === false && <Alert tone="warn">Referral cuts are switched off; rules are saved but not applied.</Alert>}
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      {rules.isPending ? <Loading label="Loading the cuts…" />
        : rules.isError && !rules.data ? <ErrorState message={messageOf(rules.error)} onRetry={() => void rules.refetch()} />
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Referral cuts by category</caption>
              <thead><tr><th scope="col">Category</th><th scope="col">Cut</th><th scope="col">Last changed</th><th scope="col">Actions</th></tr></thead>
              <tbody>
                {REFERRAL_CATEGORIES.map((c) => {
                  const r = ruleOf(rules.data.rules, c);
                  return (
                    <tr key={c}>
                      <th scope="row">{REFERRAL_CATEGORY_LABEL[c]}</th>
                      <td>
                        {referralRuleText(r)}
                        {r && !r.isActive && <div className="ws-muted">Kept but not used: {referralTermsText(r)}</div>}
                      </td>
                      <td>{r ? `${formatDateTime(r.updatedAt)} · version ${r.version}` : 'Never set'}</td>
                      <td>
                        <Button variant="secondary" aria-label={`Edit the ${catWord(c)} cut`} disabled={!!pending || guard.busy || !!editing}
                          onClick={() => { setOutcome(null); setEditing({ category: c, base: r }); }}>Edit</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      {pending ? (
        <>
          {resendError && <Alert>{resendError}</Alert>}
          <CheckPanel label="Unconfirmed change"
            onCheck={async () => {
              const now = await readNow();
              void reread();
              if (pending.restored || !pending.body) {
                return 'Read again: the cuts shown are what is saved now. The earlier change is not kept on this device, so whether it went through cannot be told. If the cuts are not what you wanted, forget it and make the change again.';
              }
              const r = ruleOf(now, pending.body.category);
              if (r && r.version > pending.body.expectedVersion) {
                settle(pending.requestKey);
                if (sameRuleTerms(r, pending.body.terms)) say('ok', savedWords(pending.body.category, r));
                else say('warn', overtakenWords(pending.body.category, r, true));
                return null;
              }
              return `Not saved so far: the ${catWord(pending.body.category)} cut is ${referralRuleText(r)} now (version ${r?.version ?? 0}). It may still be on its way. Sending the same request again is safe: it is saved at most once.`;
            }}
            resend={pending.restored || !pending.body ? undefined : {
              label: 'Send the same request again', busy: guard.busy,
              onClick: () => { void change(pending).catch((err: unknown) => setResendError(messageOf(err))); },
            }}
            forget={{ label: 'Forget it', confirmLabel: 'Yes, forget it', onForget: () => settle(pending.requestKey),
              consequence: 'The change may already have been saved, or may still be. Forgetting it does not undo that. The cuts shown are what is saved now.' }}>
            <Alert tone="warn">
              {pending.restored || !pending.body
                ? 'A change to these cuts made earlier on this device (before the page was reloaded) was not confirmed. Its details are not kept here. Check the cuts.'
                : `The outcome of this change is not known yet${pending.error ? ` (${pending.error})` : ''}: the ${catWord(pending.body.category)} cut to ${referralRuleText(pending.body.terms)}. Sending the same request again is safe.`}
            </Alert>
          </CheckPanel>
        </>
      ) : editing && rules.data && (
        <RuleEditor key={editing.category} category={editing.category} base={editing.base} name={name} busy={guard.busy}
          onSave={(terms, expectedVersion, reason) => change(startOp(newRequestKey(), { category: editing.category, terms, expectedVersion, reason }))}
          onCancel={() => setEditing(null)} />
      )}
    </section>
  );
}

/**
 * One category's cut: off, a percent of each line (with an optional cap per line) or a fixed amount per line, checked as
 * the server checks it. Save opens the confirmation (with the reason the history keeps); it is bound to the terms and the
 * version it was opened on, so a change of either closes it unconfirmed.
 */
function RuleEditor({ category, base, name, busy, onSave, onCancel }: {
  category: ReferralCategory; base: ReferralRule | null; name: string; busy: boolean;
  onSave: (terms: ReferralTerms, expectedVersion: number, reason: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<ReferralDraft>(() => referralDraftOf(base));
  const set = <K extends keyof ReferralDraft>(k: K, v: ReferralDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const { terms, errors } = referralTermsOf(d, base);
  const unchanged = !terms || (!!base && sameRuleTerms(base, terms));
  const version = base?.version ?? 0;
  const cat = catWord(category);
  const id = `rc-${category}`;
  return (
    <div className="rx-form" role="group" aria-label={`Change the ${cat} cut`}>
      <h3>Change the {cat} cut</h3>
      <fieldset className="ws-frozen" disabled={busy}>
        <div className="rx-form-row">
          <div className="j-field">
            <label htmlFor={`${id}-mode`}>Cut</label>
            <select id={`${id}-mode`} value={d.mode} onChange={(e) => set('mode', e.target.value as ReferralDraft['mode'])}>
              <option value="off">Off</option>
              <option value="percent">Percent of each line</option>
              <option value="fixed">Fixed amount per line</option>
            </select>
          </div>
          {d.mode === 'percent' && (
            <>
              <TextField label="Percent" inputMode="decimal" value={d.percent} hint="0.01 to 50, for example 10 or 2.5."
                error={d.percent.trim() ? errors.percent : undefined} onChange={(e) => set('percent', e.target.value)} />
              <TextField label="Cap per line in ₹ (optional)" inputMode="decimal" value={d.cap} hint="The most one line can earn."
                error={errors.cap} onChange={(e) => set('cap', e.target.value)} />
            </>
          )}
          {d.mode === 'fixed' && (
            <TextField label="Amount per line in ₹" inputMode="decimal" value={d.fixed} hint="At least ₹0.01; no upper limit."
              error={d.fixed.trim() ? errors.fixed : undefined} onChange={(e) => set('fixed', e.target.value)} />
          )}
        </div>
      </fieldset>
      {unchanged && !errors.percent && !errors.fixed && !errors.cap && (
        <p className="ws-muted">{d.mode === 'off' && !base ? 'No cut is set, so there is nothing to switch off.' : 'Nothing has changed yet.'}</p>
      )}
      <div className="ws-actions">
        <ConfirmAction label="Save" confirmLabel={`Save the ${cat} cut`} reason reasonLabel="Reason (kept in the history)" maxReason={MAX_REFERRAL_REASON}
          disabled={busy || unchanged} version={`${version}:${JSON.stringify(terms)}`}
          consequence={terms && (
            <>
              <p>
                {terms.isActive
                  ? <>New {cat} bookings that {name} makes: <strong>{referralTermsText(terms)}</strong> goes to {name}, taken from the {providerWord(category)} earning.</>
                  : <>New {cat} bookings that {name} makes earn it no cut.</>}
              </p>
              <p>Bookings already made keep their cut. If someone else changes this cut before you confirm, nothing is saved.</p>
            </>
          )}
          onConfirm={(reason) => (terms ? onSave(terms, version, reason) : Promise.resolve())} />
        <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

type HistoryRow = ReferralRuleEvent & { category: ReferralCategory };

/** Every change of the three cuts, newest first (one history read per category). */
function History({ kind, bookerId, queryKey }: { kind: ReferralBookerKind; bookerId: string; queryKey: readonly unknown[] }) {
  const { api } = useSession();
  const admin = useStaff();
  const rulesApi = referralRulesAdminApi(api);
  const q = useQuery({
    queryKey,
    queryFn: async (): Promise<HistoryRow[]> => (await Promise.all(REFERRAL_CATEGORIES.map(async (category) =>
      (await rulesApi.events(kind, bookerId, category)).map((e) => ({ ...e, category })))))
      .flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.version - a.version),
  });
  return (
    <section className="ws-section" aria-labelledby="rc-hist-h">
      <h2 id="rc-hist-h">History</h2>
      {q.isPending ? <Loading label="Loading the history…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title="No changes yet">Every change to these cuts is listed here, with its reason.</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">Changes to the referral cuts, newest first</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Category</th><th scope="col">Change</th><th scope="col">Reason</th><th scope="col">By</th></tr></thead>
              <tbody>
                {q.data.map((e) => (
                  <tr key={`${e.category}:${e.version}`}>
                    <td>{formatDateTime(e.at)}</td>
                    <td>{REFERRAL_CATEGORY_LABEL[e.category]}</td>
                    <td>{referralRuleText(e.before)} → {referralRuleText(e.after)}<div className="ws-muted">Version {e.version}</div></td>
                    <td>{e.reason}</td>
                    <td>{e.by === admin.id ? 'You' : 'Jansetu admin'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
