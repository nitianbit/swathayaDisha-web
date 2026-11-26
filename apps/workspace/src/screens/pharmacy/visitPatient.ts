import { useSearchParams } from 'react-router';
import { useSession } from '../../session.tsx';

/**
 * WQ54 (P1): the patient a "+ New" visit is for, chosen once on the home's first step and handed to the existing flows
 * (Book consultation, Consult now, Book lab test, New sale) so the clerk never types it twice. Held in this session's
 * memory only (a plain map: never storage, never the address); a flow reads it only when opened from + New (`?visit=1`).
 */
export interface VisitPatient { phone: string; name: string }

const slot = (pharmacyId: string) => `visit-patient:${pharmacyId}`;

export function visitPatientStore(memory: ReturnType<typeof useSession>['memory'], pharmacyId: string) {
  return {
    get: (): VisitPatient | null => memory.get<VisitPatient>(slot(pharmacyId)) ?? null,
    set: (p: VisitPatient) => memory.set(slot(pharmacyId), { phone: p.phone, name: p.name }),
    clear: () => memory.delete(slot(pharmacyId)),
  };
}

export function useVisitPatientStore(pharmacyId: string) {
  const { memory } = useSession();
  return visitPatientStore(memory, pharmacyId);
}

/** The visit's patient when this page was opened from + New (the address says only that), else null. */
export function useVisitPreset(pharmacyId: string): VisitPatient | null {
  const [params] = useSearchParams();
  const store = useVisitPatientStore(pharmacyId);
  return params.get('visit') === '1' ? store.get() : null;
}

/** The address of a flow opened from + New. */
export const visitPath = (path: string) => `${path}?visit=1`;
