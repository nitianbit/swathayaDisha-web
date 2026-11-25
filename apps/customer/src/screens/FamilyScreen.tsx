import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { customerApi, RELATIONSHIPS, type Gender, type NewDependent, type Relationship } from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading, shared, TextField } from '@jansetu/ui';
import { genderLabel, messageOf, PageHeading, relationshipLabel } from '../common.tsx';
import { t } from '../i18n/index.ts';
import { usePagedList } from '../paging.ts';
import { useCustomer, useSession } from '../session.tsx';

/** Family members the customer books for (dependents). */
export function FamilyScreen() {
  const { api } = useSession();
  const me = useCustomer();
  // Active members only, filtered by the server, paged to the end.
  const { q, items, total } = usePagedList(['dependents', me.id], (page) => customerApi(api).dependents(me.id, page));
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Link to="/profile" className="back"><ArrowLeft size={16} aria-hidden="true" /> {t('nav.profile')}</Link>
      <PageHeading title={t('family.title')}>{t('family.sub')}</PageHeading>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={t('family.empty')} />
        : (
          <>
          <ul className="list">
            {items.map((d) => (
              <li key={d._id} className="list-row">
                <strong>{d.name}</strong>
                <span className="muted">{relationshipLabel(d.relationship)}{d.gender ? ` · ${genderLabel(d.gender)}` : ''}{d.age ? ` · ${t('common.years', { years: d.age })}` : ''}</span>
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {t('family.showMore', { shown: items.length, total })}
            </Button>
          )}
          </>
        )}
      {adding ? <AddMember onDone={() => setAdding(false)} /> : <Button onClick={() => setAdding(true)}>{t('family.add')}</Button>}
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
    if (!name.trim()) errs.name = t('family.nameMissing');
    if (!relationship) errs.relationship = t('family.relationshipMissing');
    setErrors(errs);
    if (Object.keys(errs).length || !relationship) return;
    add.mutate({ name: name.trim(), relationship, ...(gender ? { gender } : {}) });
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-label={t('family.add')}>
      <TextField label={t('family.name')} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={200} />
      <div className="j-field">
        <label htmlFor="rel">{t('family.relationship')}</label>
        <select id="rel" value={relationship} aria-invalid={errors.relationship ? true : undefined}
          onChange={(e) => setRelationship(e.target.value as Relationship)}>
          <option value="">{t('common.choose')}</option>
          {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r === 'Me' ? t('common.myself') : relationshipLabel(r)}</option>)}
        </select>
        {errors.relationship && <span className="j-field__error">{errors.relationship}</span>}
      </div>
      <div className="j-field">
        <label htmlFor="gen">{t('family.genderOptional')}</label>
        <select id="gen" value={gender} onChange={(e) => setGender(e.target.value as Gender | '')}>
          <option value="">{t('family.genderUnsaid')}</option>
          <option value="Female">{genderLabel('Female')}</option><option value="Male">{genderLabel('Male')}</option><option value="Other">{genderLabel('Other')}</option>
        </select>
      </div>
      {add.isError && <Alert>{messageOf(add.error)}</Alert>}
      <div className="row">
        <Button type="submit" busy={add.isPending}>{t('common.add')}</Button>
        <Button variant="ghost" disabled={add.isPending} onClick={onDone}>{shared('action.cancel')}</Button>
      </div>
    </form>
  );
}
