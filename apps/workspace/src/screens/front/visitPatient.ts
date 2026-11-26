import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { AssistedGender, AssistedRelation, PatientLookup } from '@jansetu/api';
import { useSession, useStaff } from '../../session.tsx';

/**
 * WQ54 (P1) / WQ54b: the patient a "+ New" visit is for, chosen once on + New and handed to ONE existing flow (Book
 * consultation, Consult now, Book lab test, New sale) so the clerk never types it twice. Session memory only (a plain map,
 * never storage or the address; a new sign-in starts empty).
 * - The handover is one-shot: + New writes it, the flow opened with `?visit=1` reads it once, clears it and drops `?visit=1`
 *   from the address, so Back (or a reload) never fills a patient in again.
 * - The last patient is kept apart, only to offer "Same patient again" for 30 minutes after that visit (never the default).
 * - WQ54c: who the patient is was asked on + New (the number's owner, or a family member of theirs), so a flow books for
 *   the right person; the number's lookup is handed over too (one lookup per visit). A flow's [Change] keeps the number
 *   for + New once (`keepNumber`).
 */
export interface VisitPatient {
  phone: string;
  /** The name the pharmacy typed for them, or '' (a masked or missing name is never handed over: the flow asks). */
  name: string;
  /** A customer this pharmacy already has (found by the search): New sale sells to that customer, not a walk-in. */
  customerId?: string;
  /** The number came from the search results (or was typed twice on + New): it is not asked again. */
  confirmed: boolean;
  /** WQ54c: the patient is a family member of the number's owner (absent: the owner). */
  family?: VisitFamily;
  /** WQ54c: the number's lookup on + New (`exists`, the owner's masked name): the flow does not look it up again. */
  lookup?: PatientLookup;
}
export interface VisitFamily { relation: AssistedRelation; gender: AssistedGender | ''; dateOfBirth: string; holderName: string }

const handoverSlot = (pharmacyId: string) => `visit-handover:${pharmacyId}`;
const lastSlot = (pharmacyId: string) => `visit-last:${pharmacyId}`;
const keptSlot = (pharmacyId: string) => `visit-kept-number:${pharmacyId}`;
/** "Same patient again" is offered this long after that patient's visit. */
export const SAME_PATIENT_MS = 30 * 60_000;

type Memory = ReturnType<typeof useSession>['memory'];

export function visitStore(memory: Memory, pharmacyId: string) {
  return {
    /** + New hands `p` to the next flow (and remembers it as the last patient). */
    handOver: (p: VisitPatient, now = Date.now()) => {
      const clean: VisitPatient = { phone: p.phone, name: p.name, ...(p.customerId ? { customerId: p.customerId } : {}), confirmed: p.confirmed,
        ...(p.family ? { family: { relation: p.family.relation, gender: p.family.gender, dateOfBirth: p.family.dateOfBirth, holderName: p.family.holderName } } : {}),
        ...(p.lookup ? { lookup: { exists: p.lookup.exists, holderNameMasked: p.lookup.holderNameMasked } } : {}) };
      memory.set(handoverSlot(pharmacyId), clean);
      memory.set(lastSlot(pharmacyId), { patient: clean, at: now });
    },
    peekHandover: (): VisitPatient | null => memory.get<VisitPatient>(handoverSlot(pharmacyId)) ?? null,
    clearHandover: () => memory.delete(handoverSlot(pharmacyId)),
    /** WQ54c: a flow's [Change] keeps the number for + New (read on its first render, then cleared). */
    keepNumber: (phone: string) => memory.set(keptSlot(pharmacyId), phone),
    peekKeptNumber: (): string | null => memory.get<string>(keptSlot(pharmacyId)) ?? null,
    clearKeptNumber: () => memory.delete(keptSlot(pharmacyId)),
    /** The last patient, only within 30 minutes of that visit. */
    last: (now = Date.now()): VisitPatient | null => {
      const l = memory.get<{ patient: VisitPatient; at: number }>(lastSlot(pharmacyId));
      return l && now - l.at <= SAME_PATIENT_MS ? l.patient : null;
    },
  };
}

/** WQ55: the signed-in person's visit memory (a pharmacy, or a lab member: the same + New for both). */
export function useVisitStore() {
  const { memory } = useSession();
  return visitStore(memory, useStaff().id);
}

/** WQ55: where this person's + New is (a flow's [Change] goes back there). */
export const newVisitPath = (role: string) => (role === 'partner' ? '/partner/new' : '/pharmacy/new');

/**
 * The patient handed to this flow (read once, on the first render), else null. Then the handover is cleared and `?visit=1`
 * dropped from the address (replace): going Back to this page, or reloading it, opens it empty. While a flow is in visit
 * mode the page uses the simple home's big type and targets (`visit-mode` on the page).
 */
export function useVisitPreset(): VisitPatient | null {
  const [params, setParams] = useSearchParams();
  const store = useVisitStore();
  const [preset] = useState(() => (params.get('visit') === '1' ? store.peekHandover() : null));
  useEffect(() => {
    if (params.get('visit') !== '1') return;
    store.clearHandover();
    setParams((p) => { p.delete('visit'); return p; }, { replace: true });
  }, []);
  useVisitMode(!!preset);
  return preset;
}

/** The simple home's big type and targets on this page while `on` (a flow, or WQ54c a sale's bill, opened from + New). */
export function useVisitMode(on: boolean) {
  useEffect(() => {
    if (!on) return undefined;
    document.body.classList.add('visit-mode');
    return () => document.body.classList.remove('visit-mode');
  }, [on]);
}

/** The address of a flow opened from + New (it reads the handover once). */
export const visitPath = (path: string) => `${path}?visit=1`;
