import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { FlaskConical, Pill, Stethoscope, Video } from 'lucide-react';
import { canonicalPhone, MAX_CUSTOMER_NAME, MAX_SALE_SEARCH, pharmacySaleApi, usableCustomers } from '@jansetu/api';
import { Button, Empty, Loading, TextField } from '@jansetu/ui';
import { t } from '../../i18n/home/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { homeWords } from './home.tsx';
import { usePharmacyId } from './ownedOp.tsx';
import { useVisitPatientStore, visitPath, type VisitPatient } from './visitPatient.ts';

/**
 * WQ54 (P1) "+ New" (`/pharmacy/new`; "Find patient" opens it searching, `?find=1`): step 1 the patient (the same one as
 * the last visit, one this pharmacy has, found by phone or name with a POST search, or a new one by phone and name), step 2
 * what (Doctor, Doctor now (video), Lab test, Medicines). The chosen patient is held in this session's memory only and the
 * existing flow opens with it filled in (`?visit=1`): its own steps are when, pay and done (print or SMS where it has them).
 */
export function NewVisitScreen() {
  const pharmacyId = usePharmacyId();
  const find = useSearchParams()[0].get('find') === '1';
  const store = useVisitPatientStore(pharmacyId);
  const [patient, setPatient] = useState<VisitPatient | null>(null);
  const held = store.get();
  const choose = (p: VisitPatient) => { store.set(p); setPatient(p); };
  return (
    <div className="simple">
      <PageHeading title={find ? t('new.findTitle') : t('new.title')}>{patient ? t('new.step2', { name: patient.name }) : t('new.step1')}</PageHeading>
      {patient ? <WhatStep patient={patient} onChange={() => setPatient(null)} />
        : <PatientStep held={find ? null : held} onChoose={choose} />}
    </div>
  );
}

const patientWords = (p: VisitPatient) => `${p.name} · ${p.phone}`;

function PatientStep({ held, onChoose }: { held: VisitPatient | null; onChoose: (p: VisitPatient) => void }) {
  const { api } = useSession();
  const [another, setAnother] = useState(false);
  const [text, setText] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<{ phone?: string; name?: string }>({});
  // r36: the search is a POST: no name or phone in an address.
  const q = useQuery({ queryKey: ['pharmacy-sale', 'customers', search], queryFn: () => pharmacySaleApi(api).customers(search ?? ''), enabled: !!search });
  const rows = usableCustomers(q.data ?? []).filter((r) => r.userId.phone);

  if (held && !another) {
    return (
      <section className="ws-section" aria-labelledby="np-h">
        <h2 id="np-h">{t('new.same', { patient: patientWords(held) })}</h2>
        <div className="simple-actions">
          <Button onClick={() => onChoose(held)}>{t('new.continueSame', { name: held.name })}</Button>
          <Button variant="secondary" onClick={() => setAnother(true)}>{t('new.another')}</Button>
        </div>
      </section>
    );
  }

  function find(e: FormEvent) {
    e.preventDefault();
    const s = text.trim();
    if (!s) return;
    setSearch(s);
    const asPhone = canonicalPhone(s);
    if (asPhone) setPhone(asPhone);
  }

  function add(e: FormEvent) {
    e.preventDefault();
    const p = canonicalPhone(phone);
    const n = name.trim().replace(/\s+/g, ' ');
    const errs = { ...(p ? {} : { phone: t('new.phoneError') }), ...(n && n.length <= MAX_CUSTOMER_NAME ? {} : { name: t('new.nameError', { max: MAX_CUSTOMER_NAME }) }) };
    setErrors(errs);
    if (p && !errs.name) onChoose({ phone: p, name: n });
  }

  return (
    <>
      <section className="ws-section" aria-labelledby="np-find-h">
        <h2 id="np-find-h">{t('new.intro')}</h2>
        <form className="simple-row" role="search" noValidate onSubmit={find}>
          <TextField label={t('new.search')} hint={t('new.searchHint')} value={text} maxLength={MAX_SALE_SEARCH} autoComplete="off" inputMode="search"
            onChange={(e) => setText(e.target.value)} />
          <Button type="submit" busy={q.isFetching}>{t('new.find')}</Button>
        </form>
        {search && (!q.data ? (q.isError ? (
          <div className="simple-failed" role="alert"><p>{homeWords(q.error)}</p><Button onClick={() => void q.refetch()}>{t('tryAgain')}</Button></div>
        ) : <Loading />)
          : rows.length === 0 ? <Empty title={t('new.noneFound')} />
          : (
            <ul className="simple-choices" aria-label={t('new.results')}>
              {rows.map((r) => {
                const p = { phone: r.userId.phone!, name: r.userId.name ?? r.typedName ?? r.userId.phone! };
                return <li key={r._id}><Button variant="secondary" onClick={() => onChoose(p)}>{t('new.choose', { patient: patientWords(p) })}</Button></li>;
              })}
            </ul>
          ))}
      </section>
      <section className="ws-section" aria-labelledby="np-add-h">
        <h2 id="np-add-h">{t('new.addTitle')}</h2>
        <form className="rx-form" noValidate onSubmit={add}>
          <TextField label={t('new.phone')} value={phone} inputMode="tel" maxLength={10} autoComplete="off" error={errors.phone} onChange={(e) => setPhone(e.target.value)} />
          <TextField label={t('new.name')} value={name} maxLength={MAX_CUSTOMER_NAME} autoComplete="off" error={errors.name} onChange={(e) => setName(e.target.value)} />
          <div><Button type="submit">{t('new.next')}</Button></div>
        </form>
      </section>
    </>
  );
}

/** Step 2: what the patient needs, each the existing flow opened with the patient filled in. */
function WhatStep({ patient, onChange }: { patient: VisitPatient; onChange: () => void }) {
  const choices = [
    { to: visitPath('/pharmacy/book'), Icon: Stethoscope, label: t('new.doctor'), text: t('new.doctorText') },
    { to: visitPath('/pharmacy/consult-now'), Icon: Video, label: t('new.video'), text: t('new.videoText') },
    { to: visitPath('/pharmacy/lab-book'), Icon: FlaskConical, label: t('new.lab'), text: t('new.labText') },
    { to: visitPath('/pharmacy/sale'), Icon: Pill, label: t('new.medicines'), text: t('new.medicinesText') },
  ];
  return (
    <section className="ws-section" aria-labelledby="nw-h">
      <h2 id="nw-h">{t('new.what')}</h2>
      <p>{patientWords(patient)} <Button variant="ghost" onClick={onChange}>{t('new.changePatient')}</Button></p>
      <nav className="big-actions" aria-label={t('new.what')}>
        {choices.map(({ to, Icon, label, text }) => (
          <Link key={to} className="big-action" to={to}><Icon size={28} aria-hidden="true" />{label}<span className="big-action-text">{text}</span></Link>
        ))}
      </nav>
    </section>
  );
}
