import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { allSuppliers, type PharmacySupplier } from '@jansetu/api';
import { TextField } from '@jansetu/ui';
import { useSession } from '../../session.tsx';

/**
 * WQ11c: every active supplier of the pharmacy, all pages (`allSuppliers`, 50 a page, bounded): Add stock, Import and
 * Return to supplier offer them all, not only the first 50.
 */
export function useActiveSuppliers(pharmacyId: string) {
  const { api } = useSession();
  return useQuery({ queryKey: ['pharmacy-suppliers', pharmacyId, 'active-all'], queryFn: () => allSuppliers(api, 'active') });
}

/** Above this many suppliers the picker has a box to narrow the list by name. */
const FIND_FROM = 12;

/** A supplier select over the active suppliers, with a name filter when the list is long. The chosen one always stays listed. */
export function SupplierSelect({ id, label, suppliers, value, onChange, error, hint, noneLabel = 'Choose…', disabled }: {
  id: string;
  label: string;
  suppliers: readonly PharmacySupplier[];
  value: string;
  onChange: (supplierId: string) => void;
  error?: string;
  hint?: string;
  noneLabel?: string;
  disabled?: boolean;
}) {
  const [find, setFind] = useState('');
  const needle = find.trim().toLowerCase();
  const shown = needle ? suppliers.filter((s) => s.supplierId === value || s.displayName.toLowerCase().includes(needle)) : suppliers;
  const describedBy = [error ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <>
      {suppliers.length > FIND_FROM && (
        <TextField label={`Find the supplier (${suppliers.length})`} value={find} disabled={disabled} placeholder="Part of the name"
          onChange={(e) => setFind(e.target.value)} />
      )}
      <div className="j-field">
        <label htmlFor={id}>{label}</label>
        <select id={id} value={value} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}>
          <option value="">{noneLabel}</option>
          {shown.map((s) => <option key={s.supplierId} value={s.supplierId}>{s.displayName}</option>)}
        </select>
        {hint && <span id={`${id}-hint`} className="j-field__hint">{hint}</span>}
        {needle && shown.length === 0 && <span className="j-field__hint">No supplier name contains “{find.trim()}”.</span>}
        {error && <span id={`${id}-error`} className="j-field__error">{error}</span>}
      </div>
    </>
  );
}
