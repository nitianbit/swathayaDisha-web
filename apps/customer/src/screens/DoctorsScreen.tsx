import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { customerApi } from '@jansetu/api';
import { Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../common.tsx';
import { t } from '../i18n/index.ts';
import { usePagedList } from '../paging.ts';
import { useSession } from '../session.tsx';

/** Doctors the customer may book (the server returns only verified, active ones, scoped to the customer's company). */
export function DoctorsScreen() {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const { q, items, total } = usePagedList(['doctors', search], (page) => customerApi(api).doctors(page, 20, search));
  return (
    <>
      <PageHeading title={t('common.bookDoctor')} />
      <form className="row" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setSearch(text.trim()); }}>
        <TextField label={t('doctors.search')} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('doctors.searchPlaceholder')} />
        <Button type="submit">{t('common.search')}</Button>
      </form>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={search ? t('doctors.noMatch', { search }) : t('doctors.none')} />
        : (
          <>
            <ul className="list">
              {items.map((d) => (
                <li key={d._id}>
                  <Link to={`/doctors/${d._id}`} className="list-row link-row">
                    <strong>{d.name}</strong>
                    <span className="muted">{[d.specialization, d.experienceYears ? t('common.years', { years: d.experienceYears }) : '', d.city].filter(Boolean).join(' · ')}</span>
                    <span>{d.isConsultationFree || !d.consultationFee ? t('doctors.freeConsultation') : formatRupees(d.consultationFee)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="muted">{t('common.showing', { shown: items.length, total })}</p>
            {q.hasNextPage && <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('common.showMore')}</Button>}
          </>
        )}
    </>
  );
}
