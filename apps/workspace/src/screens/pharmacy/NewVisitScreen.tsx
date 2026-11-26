import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { canonicalPhone, MAX_CUSTOMER_NAME, pharmacySaleApi, usableCustomers } from '@jansetu/api';
import { Alert, Button, Loading, TextField } from '@jansetu/ui';
import { t } from '../../i18n/home/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { Failed } from './home.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { HomeButton } from './visitBar.tsx';
import { useVisitStore, visitPath, type VisitPatient } from './visitPatient.ts';

/**
 * WQ54 (P1) / WQ54b "+ New" (`/pharmacy/new`; "Find patient" opens the same step, `?find=1`: there is no patient history
 * page yet). Step 1, the patient, by one phone field: a patient this pharmacy has is tapped; a new number asks for the name
 * (and the number again) on the same screen. "Same patient again" is only a small second choice, for 30 minutes after that
 * visit. Step 2, what, in plain words. The patient is handed once to the chosen flow (session memory only).
 */
export function NewVisitScreen() {
  const pharmacyId = usePharmacyId();
  const find = useSearchParams()[0].get('find') === '1';
  const store = useVisitStore(pharmacyId);
  const [patient, setPatient] = useState<VisitPatient | null>(null);
  const [last] = useState(() => (find ? null : store.last()));
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
      <PageHeading title={find ? t('new.findTitle') : t('new.title')} />
      <div className="simple-top"><HomeButton /></div>
      {patient ? <WhatStep patient={patient} heading={heading} onPick={() => store.handOver(patient)} onChange={() => setPatient(null)} />
        : <PatientStep last={last} heading={heading} onChoose={setPatient} />}
    </div>
  );
}

const patientWords = (p: VisitPatient) => (p.name ? `${p.name} · ${p.phone}` : p.phone);

function PatientStep({ last, heading, onChoose }: { last: VisitPatient | null; heading: RefObject<HTMLHeadingElement | null>; onChoose: (p: VisitPatient) => void }) {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<{ name?: string; again?: string }>({});
  // r36: the search is a POST: the number is never in an address.
  const q = useQuery({ queryKey: ['pharmacy-sale', 'customers', phone], queryFn: () => pharmacySaleApi(api).customers(phone ?? ''), enabled: !!phone });
  const found = usableCustomers(q.data ?? []).flatMap((r) => {
    const p = canonicalPhone(r.userId.phone ?? '');
    return p ? [{ r, p }] : [];
  });

  function find(e: FormEvent) {
    e.preventDefault();
    const p = canonicalPhone(text);
    setPhoneError(p ? null : t('new.phoneError'));
    setPhone(p);
    setName(''); setAgain(''); setErrors({});
  }

  function add(e: FormEvent) {
    e.preventDefault();
    if (!phone) return;
    const n = name.trim().replace(/\s+/g, ' ');
    const errs = {
      ...(n && n.length <= MAX_CUSTOMER_NAME ? {} : { name: t('new.nameError', { max: MAX_CUSTOMER_NAME }) }),
      ...(canonicalPhone(again) === phone ? {} : { again: t('new.againError') }),
    };
    setErrors(errs);
    // Typed twice here: the flow does not ask for the number again.
    if (!errs.name && !errs.again) onChoose({ phone, name: n, confirmed: true });
  }

  return (
    <section className="ws-section" aria-labelledby="np-h">
      <h2 id="np-h" ref={heading} tabIndex={-1}>{t('new.step1')}</h2>
      <form className="simple-row" role="search" noValidate onSubmit={find}>
        <TextField label={t('new.phone')} hint={t('new.phoneHint')} value={text} inputMode="tel" maxLength={14} autoComplete="off" error={phoneError}
          onChange={(e) => setText(e.target.value)} />
        <Button type="submit" busy={q.isFetching}>{t('new.find')}</Button>
      </form>
      {phone && (!q.data ? (q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : <Loading />)
        : found.length > 0 ? (
          <ul className="simple-choices" aria-label={t('new.results')}>
            {found.map(({ r, p }) => (
              <li key={r._id}>
                {/* WQ54b: only the name this pharmacy typed is handed over; a masked one is shown here but asked in the flow. */}
                <Button variant="secondary" onClick={() => onChoose({ phone: p, name: r.typedName ?? '', customerId: r.userId._id, confirmed: true })}>
                  {`${r.typedName ?? r.userId.name ?? t('new.noName')} · ${p}`}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <form className="rx-form" noValidate onSubmit={add}>
            <Alert tone="warn">{t('new.notFound')}</Alert>
            <TextField label={t('new.name')} value={name} maxLength={MAX_CUSTOMER_NAME} autoComplete="off" error={errors.name} onChange={(e) => setName(e.target.value)} />
            <TextField label={t('new.again')} value={again} inputMode="tel" maxLength={14} autoComplete="off" error={errors.again} onChange={(e) => setAgain(e.target.value)} />
            <div><Button type="submit">{t('new.next')}</Button></div>
          </form>
        ))}
      {last && <p className="simple-last"><Button variant="ghost" onClick={() => onChoose(last)}>{t('new.sameAgain', { name: last.name || last.phone })}</Button></p>}
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
      <p>{patientWords(patient)} <Button variant="ghost" onClick={onChange}>{t('new.changePatient')}</Button></p>
      <nav className="big-actions big-actions--two" aria-label={t('new.what')}>
        {choices.map(({ to, label }) => <Link key={to} className="big-action" to={to} onClick={onPick}>{label}</Link>)}
      </nav>
    </section>
  );
}
