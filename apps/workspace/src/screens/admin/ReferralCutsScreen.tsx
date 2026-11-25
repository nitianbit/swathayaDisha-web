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
import { t } from '../../i18n/admin/index.ts';
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
  if (!OBJECT_ID_PATTERN.test(pharmacyId)) return (
    <NoSuchRecord back="/admin/pharmacies" backLabel={t('common.backToPharmacies')} title={t('referralCuts.title')} missing={t('referralCuts.noSuch')}>
      {t('referralCuts.noSuchPharmacyHint')}
    </NoSuchRecord>
  );
  return <ReferralCuts key={`${scope.identity}:pharmacy:${pharmacyId}`} kind="pharmacy" bookerId={pharmacyId.toLowerCase()} scopeKey={scope.key} />;
}

/** `/admin/partners/:partnerId/referral-cuts`, linked from a lab's admin page (clinics book no patients for others). */
export function LabReferralCutsScreen() {
  const { partnerId = '' } = useParams();
  const scope = useAdminScope('referral-cuts');
  if (!OBJECT_ID_PATTERN.test(partnerId)) return (
    <NoSuchRecord back="/admin/partners" backLabel={t('common.backToPartners')} title={t('referralCuts.title')} missing={t('referralCuts.noSuch')}>
      {t('referralCuts.noSuchLabHint')}
    </NoSuchRecord>
  );
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
  const backLabel = name !== undefined ? t('referralCuts.backTo', { name })
    : kind === 'pharmacy' ? t('referralCuts.backToPharmacy') : t('referralCuts.backToLab');
  return (
    <>
      <Link className="ws-back" to={back}><ArrowLeft size={16} aria-hidden="true" /> {backLabel}</Link>
      <PageHeading title={name ? t('referralCuts.titleFor', { name }) : t('referralCuts.title')}>
        {name !== undefined ? t('referralCuts.intro', { name }) : t('referralCuts.introNoName')}
      </PageHeading>
      {booker.isPending ? <Loading label={t('referralCuts.loading')} />
        : booker.isError ? <ErrorState message={messageOf(booker.error)} onRetry={() => void booker.refetch()} />
        : !booker.data.cuts ? <Empty title={t('referralCuts.noClinics')}>{t('referralCuts.noClinicsHint')}</Empty>
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

/** A category inside a sentence ("the lab test cut"): keys, worded when shown. */
const CATEGORY_WORD = {
  consultation: 'referralCuts.catConsultation', lab_test: 'referralCuts.catLabTest', lab_package: 'referralCuts.catLabPackage',
} as const satisfies Record<ReferralCategory, string>;
const catWord = (c: ReferralCategory) => t(CATEGORY_WORD[c]);

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
    const words = { category: catWord(c), name, version: r?.version ?? 0 };
    // Off (no rule, or switched off) is said in the sentence itself; `referralRuleText` words the terms otherwise.
    return !r || r.isActive !== true ? t('referralCuts.savedOff', words) : t('referralCuts.saved', { ...words, terms: referralRuleText(r) });
  };
  /** `sentBefore`: an earlier attempt may have been saved and then changed again, so it is not said that it was not saved. */
  const overtakenWords = (c: ReferralCategory, r: ReferralRule | null, sentBefore = false) => {
    const words = { category: catWord(c), terms: referralRuleText(r), version: r?.version ?? 0 };
    return sentBefore ? t('referralCuts.overtakenSentBefore', words) : t('referralCuts.overtaken', words);
  };

  /**
   * 409 RECORD_CHANGED: this attempt wrote nothing. The rules as read now tell the rest: for a change already sent before
   * (uncertain), a newer version with the same terms is the change itself; anything else was someone else's.
   */
  async function afterConflict(p: PendingOp<RuleChange>, uncertain: boolean) {
    const now = await readNow().catch(() => null);
    if (!now) {
      // Uncertain: it stays unconfirmed (below) until a check can read the cuts.
      if (!uncertain) say('warn', `${REFERRAL_RULE_REFUSAL.RECORD_CHANGED} ${t('referralCuts.rereadFailed')}`);
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
      say('error', t('referralCuts.notSaved', { reason: referralRuleRefusal(r.error) }));
    } else if (live.current) {
      // No answer: the change is kept as unconfirmed (below) until it is checked.
      setEditing(null);
    }
    void reread();
  }

  const pending = op && !(guard.busy && op.attempts === 1 && !op.uncertain) ? op : undefined;
  const pendingWords = (b: RuleChange) => ({ category: catWord(b.category), terms: referralRuleText(b.terms) });
  // r33: the server says whether REFERRAL_CUTS_ENABLED is on (null from a server that does not say: no note).
  const on = rules.data?.switches?.cutsEnabled ?? null;
  return (
    <section className="ws-section" aria-labelledby="rc-h">
      <h2 id="rc-h">{t('referralCuts.byCategory')}</h2>
      <p className="ws-muted">{t('referralCuts.byCategoryHint')}</p>
      {on === false && <Alert tone="warn">{t('referralCuts.switchedOff')}</Alert>}
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      {rules.isPending ? <Loading label={t('referralCuts.loadingCuts')} />
        : rules.isError && !rules.data ? <ErrorState message={messageOf(rules.error)} onRetry={() => void rules.refetch()} />
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('referralCuts.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('referralCuts.category')}</th><th scope="col">{t('referralCuts.cut')}</th>
                  <th scope="col">{t('referralCuts.lastChanged')}</th><th scope="col">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {REFERRAL_CATEGORIES.map((c) => {
                  const r = ruleOf(rules.data.rules, c);
                  return (
                    <tr key={c}>
                      <th scope="row">{REFERRAL_CATEGORY_LABEL[c]}</th>
                      <td>
                        {referralRuleText(r)}
                        {r && !r.isActive && <div className="ws-muted">{t('referralCuts.keptNotUsed', { terms: referralTermsText(r) })}</div>}
                      </td>
                      <td>{r ? t('referralCuts.changedAt', { when: formatDateTime(r.updatedAt), version: r.version }) : t('referralCuts.neverSet')}</td>
                      <td>
                        <Button variant="secondary" aria-label={t('referralCuts.editLabel', { category: catWord(c) })} disabled={!!pending || guard.busy || !!editing}
                          onClick={() => { setOutcome(null); setEditing({ category: c, base: r }); }}>{t('referralCuts.edit')}</Button>
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
          <CheckPanel label={t('referralCuts.unconfirmed')}
            onCheck={async () => {
              const now = await readNow();
              void reread();
              if (pending.restored || !pending.body) {
                return t('referralCuts.checkUnknown');
              }
              const r = ruleOf(now, pending.body.category);
              if (r && r.version > pending.body.expectedVersion) {
                settle(pending.requestKey);
                if (sameRuleTerms(r, pending.body.terms)) say('ok', savedWords(pending.body.category, r));
                else say('warn', overtakenWords(pending.body.category, r, true));
                return null;
              }
              return t('referralCuts.checkNotYet', { category: catWord(pending.body.category), terms: referralRuleText(r), version: r?.version ?? 0 });
            }}
            resend={pending.restored || !pending.body ? undefined : {
              label: t('referralCuts.sendAgain'), busy: guard.busy,
              onClick: () => { void change(pending).catch((err: unknown) => setResendError(messageOf(err))); },
            }}
            forget={{ label: t('referralCuts.forget'), confirmLabel: t('referralCuts.forgetConfirm'), onForget: () => settle(pending.requestKey),
              consequence: t('referralCuts.forgetConsequence') }}>
            <Alert tone="warn">
              {pending.restored || !pending.body ? t('referralCuts.pendingRestored')
                : pending.error ? t('referralCuts.pendingUnknownWithError', { error: pending.error, ...pendingWords(pending.body) })
                : t('referralCuts.pendingUnknown', pendingWords(pending.body))}
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
    <div className="rx-form" role="group" aria-label={t('referralCuts.editorTitle', { category: cat })}>
      <h3>{t('referralCuts.editorTitle', { category: cat })}</h3>
      <fieldset className="ws-frozen" disabled={busy}>
        <div className="rx-form-row">
          <div className="j-field">
            <label htmlFor={`${id}-mode`}>{t('referralCuts.cut')}</label>
            <select id={`${id}-mode`} value={d.mode} onChange={(e) => set('mode', e.target.value as ReferralDraft['mode'])}>
              <option value="off">{t('referralCuts.modeOff')}</option>
              <option value="percent">{t('referralCuts.modePercent')}</option>
              <option value="fixed">{t('referralCuts.modeFixed')}</option>
            </select>
          </div>
          {d.mode === 'percent' && (
            <>
              <TextField label={t('referralCuts.percent')} inputMode="decimal" value={d.percent} hint={t('referralCuts.percentHint')}
                error={d.percent.trim() ? errors.percent : undefined} onChange={(e) => set('percent', e.target.value)} />
              <TextField label={t('referralCuts.cap')} inputMode="decimal" value={d.cap} hint={t('referralCuts.capHint')}
                error={errors.cap} onChange={(e) => set('cap', e.target.value)} />
            </>
          )}
          {d.mode === 'fixed' && (
            <TextField label={t('referralCuts.fixed')} inputMode="decimal" value={d.fixed} hint={t('referralCuts.fixedHint')}
              error={d.fixed.trim() ? errors.fixed : undefined} onChange={(e) => set('fixed', e.target.value)} />
          )}
        </div>
      </fieldset>
      {unchanged && !errors.percent && !errors.fixed && !errors.cap && (
        <p className="ws-muted">{d.mode === 'off' && !base ? t('referralCuts.nothingToSwitchOff') : t('referralCuts.unchanged')}</p>
      )}
      <div className="ws-actions">
        <ConfirmAction label={t('referralCuts.save')} confirmLabel={t('referralCuts.saveConfirm', { category: cat })} reason reasonLabel={t('referralCuts.reasonLabel')}
          maxReason={MAX_REFERRAL_REASON}
          disabled={busy || unchanged} version={`${version}:${JSON.stringify(terms)}`}
          consequence={terms && (
            <>
              <p>
                {terms.isActive
                  ? t.rich(category === 'consultation' ? 'referralCuts.confirmActiveDoctor' : 'referralCuts.confirmActiveLab',
                    { category: cat, name, terms: <strong key="terms">{referralTermsText(terms)}</strong> })
                  : t('referralCuts.confirmInactive', { category: cat, name })}
              </p>
              <p>{t('referralCuts.confirmKeep')}</p>
            </>
          )}
          onConfirm={(reason) => (terms ? onSave(terms, version, reason) : Promise.resolve())} />
        <Button variant="ghost" disabled={busy} onClick={onCancel}>{t('referralCuts.cancel')}</Button>
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
      <h2 id="rc-hist-h">{t('referralCuts.history')}</h2>
      {q.isPending ? <Loading label={t('referralCuts.loadingHistory')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title={t('referralCuts.noChanges')}>{t('referralCuts.noChangesHint')}</Empty>
        : (
          <div className="ws-table-wrap">
            <table className="j-table">
              <caption className="j-sr-only">{t('referralCuts.historyCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('referralCuts.when')}</th><th scope="col">{t('referralCuts.category')}</th>
                  <th scope="col">{t('referralCuts.change')}</th><th scope="col">{t('referralCuts.reason')}</th><th scope="col">{t('referralCuts.by')}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((e) => (
                  <tr key={`${e.category}:${e.version}`}>
                    <td>{formatDateTime(e.at)}</td>
                    <td>{REFERRAL_CATEGORY_LABEL[e.category]}</td>
                    <td>{referralRuleText(e.before)} → {referralRuleText(e.after)}<div className="ws-muted">{t('referralCuts.version', { version: e.version })}</div></td>
                    <td>{e.reason}</td>
                    <td>{e.by === admin.id ? t('referralCuts.byYou') : t('referralCuts.byAdmin')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
