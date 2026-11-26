import './home.css';
import { Link, useNavigate } from 'react-router';
import { House } from 'lucide-react';
import { Button, Parts } from '@jansetu/ui';
import { t } from '../../i18n/home/index.ts';
import { useStaff } from '../../session.tsx';
import { newVisitPath, useVisitStore, type VisitPatient } from './visitPatient.ts';

/** WQ54b: back to the simple home, on the page itself (+ New, Today, a flow opened from + New); a phone has it in the header. */
export function HomeButton() {
  return <Link className="j-btn j-btn--secondary home-button" to="/"><House size={20} aria-hidden="true" /> {t('home')}</Link>;
}

/** Who a visit is for: "Asha · 98…", or WQ54c a family member "Ravi (son of R*** K***)". */
export function visitWho(p: VisitPatient): string {
  if (!p.family) return p.name ? `${p.name} · ${p.phone}` : p.phone;
  const holder = p.lookup?.holderNameMasked || p.family.holderName || p.phone;
  return t('visit.family', { name: p.name, relation: p.family.relation.toLowerCase(), holder });
}

/**
 * WQ54b: a flow opened from + New names its patient once ("Patient: Asha · 98…") instead of asking again. Change goes back
 * to + New's first step with the number kept (WQ54c; not while something is being sent).
 */
export function VisitPatientLine({ patient, canChange }: { patient: VisitPatient; canChange: boolean }) {
  const store = useVisitStore();
  const { role } = useStaff();
  const navigate = useNavigate();
  return (
    <div className="visit-line">
      <p><Parts of={t.rich('visit.patient', { who: <strong>{visitWho(patient)}</strong> })} /></p>
      {canChange && <Button variant="secondary" onClick={() => { store.keepNumber(patient.phone); navigate(newVisitPath(role)); }}>{t('visit.change')}</Button>}
      <HomeButton />
    </div>
  );
}
