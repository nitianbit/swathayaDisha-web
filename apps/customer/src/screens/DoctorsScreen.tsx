import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { customerApi } from '@jansetu/api';
import { Button, Empty, ErrorState, formatRupees, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../common.tsx';
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
      <PageHeading title="Book a doctor" />
      <form className="row" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setSearch(text.trim()); }}>
        <TextField label="Doctor or speciality" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. cardiologist" />
        <Button type="submit">Search</Button>
      </form>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title={search ? `No doctors match “${search}”` : 'No doctors available yet'} />
        : (
          <>
            <ul className="list">
              {items.map((d) => (
                <li key={d._id}>
                  <Link to={`/doctors/${d._id}`} className="list-row link-row">
                    <strong>{d.name}</strong>
                    <span className="muted">{[d.specialization, d.experienceYears ? `${d.experienceYears} years` : '', d.city].filter(Boolean).join(' · ')}</span>
                    <span>{d.isConsultationFree || !d.consultationFee ? 'Free consultation' : formatRupees(d.consultationFee)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="muted">Showing {items.length} of {total}.</p>
            {q.hasNextPage && <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Show more</Button>}
          </>
        )}
    </>
  );
}
