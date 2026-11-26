import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  canonicalPhone, EMPTY_PATIENT, istToday, MAX_SALE_SEARCH, patientProblems, pharmacyAssistedApi, pharmacySaleApi, pharmacyTodayApi, usableCustomers,
  type AssistedRelation, type PatientDraft,
} from '@jansetu/api';
import { Alert, Button, Loading, TextField } from '@jansetu/ui';
import { t } from '../../i18n/home/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { Failed, Register } from './home.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { PatientFields } from './patientStep.tsx';
import { HomeButton, visitWho } from './visitBar.tsx';
import { useVisitStore, visitPath, type VisitPatient } from './visitPatient.ts';

/**
 * WQ54 (P1) / WQ54b / WQ54c "+ New" (`/pharmacy/new`; "Find patient" opens the same step, `?find=1`, with the patient's
 * visits of today). Step 1, the patient, the one place the patient is chosen: one box (digits: the phone; letters: a name,
 * this pharmacy's patients), then for the number: whether it is on Jansetu (the owner's masked name) and who the patient
 * is: "This person" (their name) or "Someone else (family member)" (name, relation, sex, date of birth). Step 2, what, in
 * plain words. The patient is handed once to the chosen flow (session memory only). Every Find asks the server.
 */
export function NewVisitScreen() {
  const pharmacyId = usePharmacyId();
  const find = useSearchParams()[0].get('find') === '1';
  const store = useVisitStore(pharmacyId);
  const [patient, setPatient] = useState<VisitPatient | null>(null);
  const [last] = useState(() => (find ? null : store.last()));
  // WQ54c: a flow's [Change] came back here with its number (read once).
  const [kept] = useState(() => store.peekKeptNumber());
  useEffect(() => { store.clearKeptNumber(); }, []);
  // Each step change moves the focus to the step's heading (not on the first showing).
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef<VisitPatient | null>(null);
  useEffect(() => {
    if (shown.current === patient) return;
    shown.current = patient;
    heading.current?.focus();
  }, [patient]);
  return (
    <div className="simple">
      <PageHeading title={find ? t('new.findTitle') : t('new.title')}>{find ? t('new.findIntro') : null}</PageHeading>
      <div className="simple-top"><HomeButton /></div>
      {patient ? <WhatStep patient={patient} heading={heading} onPick={() => store.handOver(patient)} onChange={() => setPatient(null)} />
        : <PatientStep last={last} kept={kept} find={find} heading={heading} onChoose={setPatient} />}
    </div>
  );
}

const DIGITS = /^[\d\s+()-]+$/;

function PatientStep({ last, kept, find, heading, onChoose }: {
  last: VisitPatient | null; kept: string | null; find: boolean; heading: RefObject<HTMLHeadingElement | null>; onChoose: (p: VisitPatient) => void;
}) {
  const { api } = useSession();
  const [text, setText] = useState(kept ?? '');
  const [error, setError] = useState<string | null>(null);
  /** The number being asked about, or the name searched; `ask` changes on every Find, so each Find asks the server. */
  const [phone, setPhone] = useState<string | null>(kept);
  const [name, setName] = useState<string | null>(null);
  const [ask, setAsk] = useState(0);
  // r36: the search is a POST: nothing typed is in an address.
  const byName = useQuery({ queryKey: ['visit-find', 'name', name, ask], queryFn: () => pharmacySaleApi(api).customers(name ?? ''), enabled: !!name, gcTime: 0 });
  const found = usableCustomers(byName.data ?? []).flatMap((r) => {
    const p = canonicalPhone(r.userId.phone ?? '');
    return p ? [{ r, p }] : [];
  });

  function search(e: FormEvent) {
    e.preventDefault();
    const s = text.trim();
    setAsk((n) => n + 1);
    if (DIGITS.test(s)) {
      const p = canonicalPhone(s);
      setError(p ? null : t('new.phoneError'));
      setPhone(p); setName(null);
      return;
    }
    const ok = s.length >= 2;
    setError(ok ? null : t('new.searchError'));
    setPhone(null); setName(ok ? s : null);
  }

  return (
    <section className="ws-section" aria-labelledby="np-h">
      <h2 id="np-h" ref={heading} tabIndex={-1}>{t('new.step1')}</h2>
      <form className="simple-row" role="search" noValidate onSubmit={search}>
        <TextField label={t('new.search')} hint={t('new.searchHint')} value={text} maxLength={MAX_SALE_SEARCH} autoComplete="off" error={error}
          onChange={(e) => setText(e.target.value)} />
        <Button type="submit" busy={byName.isFetching}>{t('new.find')}</Button>
      </form>
      {name && (!byName.data ? (byName.isError ? <Failed error={byName.error} onRetry={() => void byName.refetch()} /> : <Loading />)
        : found.length === 0 ? <p>{t('new.noneByName')}</p>
        : (
          <ul className="simple-choices" aria-label={t('new.results')}>
            {found.map(({ r, p }) => (
              <li key={r._id}>
                <Button variant="secondary" onClick={() => { setName(null); setText(p); setPhone(p); setAsk((n) => n + 1); }}>
                  {`${r.typedName ?? r.userId.name ?? t('new.noName')} · ${p}`}
                </Button>
              </li>
            ))}
          </ul>
        ))}
      {phone && <WhoStep key={`${phone}:${ask}`} phone={phone} ask={ask} find={find} onChoose={onChoose} />}
      {last && !phone && <p className="simple-last"><Button variant="ghost" onClick={() => onChoose(last)}>{t('new.sameAgain', { name: last.name || last.phone })}</Button></p>}
    </section>
  );
}

/**
 * WQ54c: who the patient is on this number. The lookup (counted by the server) and this pharmacy's own record of the
 * number are read once per Find and handed over, so the flow does not look it up again.
 */
function WhoStep({ phone, ask, find, onChoose }: { phone: string; ask: number; find: boolean; onChoose: (p: VisitPatient) => void }) {
  const { api } = useSession();
  const q = useQuery({
    queryKey: ['visit-find', 'phone', phone, ask],
    queryFn: async () => {
      const [lookup, rows] = await Promise.all([pharmacyAssistedApi(api).lookup(phone), pharmacySaleApi(api).customers(phone)]);
      return { lookup, own: usableCustomers(rows).find((r) => canonicalPhone(r.userId.phone ?? '') === phone) ?? null };
    },
    gcTime: 0, retry: false,
  });
  const [draft, setDraft] = useState<PatientDraft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof PatientDraft, string>>>({});
  const set = <K extends keyof PatientDraft>(k: K, v: PatientDraft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  if (!q.data) return q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : <Loading />;
  const { lookup, own } = q.data;
  // Only the name this pharmacy typed is offered; a masked one is shown as such and never handed over.
  const choose = (who: 'self' | 'family') => { setErrors({}); setDraft({ ...EMPTY_PATIENT, phone, who, name: who === 'self' ? own?.typedName ?? '' : '' }); };

  function next(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const problems = patientProblems(draft, lookup.exists);
    setErrors(problems);
    if (Object.keys(problems).length) return;
    onChoose({ phone, name: draft.name.trim().replace(/\s+/g, ' '), ...(own ? { customerId: own.userId._id } : {}), confirmed: true, lookup,
      ...(draft.who === 'family' ? { family: { relation: draft.relation as AssistedRelation, gender: draft.gender, dateOfBirth: draft.dateOfBirth,
        holderName: draft.holderName.trim().replace(/\s+/g, ' ') } } : {}) });
  }

  return (
    <div className="who-step">
      <Alert tone={lookup.exists ? 'ok' : 'warn'}>
        {lookup.exists ? t('new.onJansetu', { name: lookup.holderNameMasked ?? t('new.noName') }) : t('new.newNumber')}
      </Alert>
      <div className="big-actions big-actions--two" role="group" aria-label={t('new.whoIs')}>
        <button type="button" className="big-action" aria-pressed={draft?.who === 'self'} onClick={() => choose('self')}>{t('new.thisPerson')}</button>
        <button type="button" className="big-action" aria-pressed={draft?.who === 'family'} onClick={() => choose('family')}>{t('new.someoneElse')}</button>
      </div>
      {draft && (
        <form className="rx-form" noValidate onSubmit={next}>
          <PatientFields patient={draft} set={set} errors={errors} />
          {!lookup.exists && (
            <TextField label={t('new.again')} value={draft.phoneAgain} inputMode="tel" maxLength={14} autoComplete="off" error={errors.phoneAgain}
              onChange={(e) => set('phoneAgain', e.target.value)} />
          )}
          <div><Button type="submit">{t('new.next')}</Button></div>
        </form>
      )}
      {find && <TodayVisits phone={phone} ask={ask} />}
    </div>
  );
}

/** WQ54c: Find patient shows the number's visits of today (r37c's day search by phone). */
function TodayVisits({ phone, ask }: { phone: string; ask: number }) {
  const { api } = useSession();
  const day = istToday();
  const q = useQuery({ queryKey: ['visit-find', 'today', phone, ask], queryFn: () => pharmacyTodayApi(api).search({ date: day, q: phone, order: 'desc', limit: 10 }), gcTime: 0 });
  return (
    <section aria-labelledby="np-today-h">
      <h3 id="np-today-h">{t('new.todayVisits')}</h3>
      {!q.data ? (q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : <Loading />)
        : q.data.items.length === 0 ? <p className="ws-muted">{t('new.noVisits')}</p> : <Register items={q.data.items} date={day} />}
    </section>
  );
}

/** Step 2: what the patient needs, in plain words; each opens the existing flow with the patient handed over once. */
function WhatStep({ patient, heading, onPick, onChange }: {
  patient: VisitPatient; heading: RefObject<HTMLHeadingElement | null>; onPick: () => void; onChange: () => void;
}) {
  const choices = [
    { to: visitPath('/pharmacy/consult-now'), label: t('new.video') },
    { to: visitPath('/pharmacy/book'), label: t('new.doctor') },
    { to: visitPath('/pharmacy/lab-book'), label: t('new.lab') },
    { to: visitPath('/pharmacy/sale'), label: t('new.medicines') },
  ];
  return (
    <section className="ws-section" aria-labelledby="nw-h">
      <h2 id="nw-h" ref={heading} tabIndex={-1}>{patient.name ? t('new.step2', { name: patient.name }) : t('new.step2NoName')}</h2>
      <p>{visitWho(patient)} <Button variant="ghost" onClick={onChange}>{t('new.changePatient')}</Button></p>
      <nav className="big-actions big-actions--two" aria-label={t('new.what')}>
        {choices.map(({ to, label }) => <Link key={to} className="big-action" to={to} onClick={onPick}>{label}</Link>)}
      </nav>
    </section>
  );
}
