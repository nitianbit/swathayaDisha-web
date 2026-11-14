import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { customerApi, RELATIONSHIPS, type Gender, type NewDependent, type Relationship } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../common.tsx';
import { useCustomer, useSession } from '../session.tsx';

/** Family members the customer books for (dependents). */
export function FamilyScreen() {
  const { api } = useSession();
  const me = useCustomer();
  const q = useQuery({ queryKey: ['dependents', me.id], queryFn: () => customerApi(api).dependents(me.id) });
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Link to="/profile" className="back"><ArrowLeft size={16} aria-hidden="true" /> Profile</Link>
      <PageHeading title="Family members">People you can book appointments and tests for.</PageHeading>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title="No family members yet" />
        : (
          <ul className="list">
            {q.data.items.filter((d) => d.isActive !== false).map((d) => (
              <li key={d._id} className="list-row">
                <strong>{d.name}</strong>
                <span className="muted">{d.relationship}{d.gender ? ` · ${d.gender}` : ''}{d.age ? ` · ${d.age} years` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      {adding ? <AddMember onDone={() => setAdding(false)} /> : <Button onClick={() => setAdding(true)}>Add a family member</Button>}
    </>
  );
}

function AddMember({ onDone }: { onDone: () => void }) {
  const { api } = useSession();
  const me = useCustomer();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState<Relationship | ''>('');
  const [gender, setGender] = useState<Gender | ''>('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const add = useMutation({
    mutationFn: (body: NewDependent) => customerApi(api).addDependent(me.id, body),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['dependents', me.id] }); onDone(); },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Enter their name.';
    if (!relationship) errs.relationship = 'Choose how they are related to you.';
    setErrors(errs);
    if (Object.keys(errs).length || !relationship) return;
    add.mutate({ name: name.trim(), relationship, ...(gender ? { gender } : {}) });
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-label="Add a family member">
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={200} />
      <div className="j-field">
        <label htmlFor="rel">Relationship</label>
        <select id="rel" value={relationship} aria-invalid={errors.relationship ? true : undefined}
          onChange={(e) => setRelationship(e.target.value as Relationship)}>
          <option value="">Choose…</option>
          {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r === 'Me' ? 'Myself' : r}</option>)}
        </select>
        {errors.relationship && <span className="j-field__error">{errors.relationship}</span>}
      </div>
      <div className="j-field">
        <label htmlFor="gen">Gender (optional)</label>
        <select id="gen" value={gender} onChange={(e) => setGender(e.target.value as Gender | '')}>
          <option value="">Prefer not to say</option>
          <option value="Female">Female</option><option value="Male">Male</option><option value="Other">Other</option>
        </select>
      </div>
      {add.isError && <Alert>{messageOf(add.error)}</Alert>}
      <div className="row">
        <Button type="submit" busy={add.isPending}>Add</Button>
        <Button variant="ghost" disabled={add.isPending} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
