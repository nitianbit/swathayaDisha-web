import './home.css';
import { Link } from 'react-router';
import { House } from 'lucide-react';
import { Parts } from '@jansetu/ui';
import { t } from '../../i18n/home/index.ts';
import type { VisitPatient } from './visitPatient.ts';

/** WQ54b: back to the simple home, on the page itself (+ New, Today, a flow opened from + New); a phone has it in the header. */
export function HomeButton() {
  return <Link className="j-btn j-btn--secondary home-button" to="/"><House size={20} aria-hidden="true" /> {t('home')}</Link>;
}

/**
 * WQ54b: a flow opened from + New names its patient once ("Patient: Asha · 98…") instead of asking again. Change opens
 * + New's search (not while something is being sent).
 */
export function VisitPatientLine({ patient, canChange }: { patient: VisitPatient; canChange: boolean }) {
  const who = patient.name ? `${patient.name} · ${patient.phone}` : patient.phone;
  return (
    <div className="visit-line">
      <p><Parts of={t.rich('visit.patient', { who: <strong>{who}</strong> })} /></p>
      {canChange && <Link className="j-btn j-btn--secondary" to="/pharmacy/new">{t('visit.change')}</Link>}
      <HomeButton />
    </div>
  );
}
