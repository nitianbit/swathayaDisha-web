import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { customerLabsApi, LAB_PINCODE_PATTERN } from '@jansetu/api';
import { Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { useSession } from '../../session.tsx';

/** Partner labs near the customer (by pincode or city); lab tests booked through other providers stay in My bookings. */
export function LabsScreen() {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [place, setPlace] = useState('');
  const filter = LAB_PINCODE_PATTERN.test(place) ? { pincode: place } : place ? { city: place } : {};
  const q = useQuery({ queryKey: ['partner-labs', filter], queryFn: () => customerLabsApi(api).labs(filter) });
  return (
    <>
      <PageHeading title="Lab tests">Book tests at a partner lab, or have a sample collected at home.</PageHeading>
      <form className="row" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setPlace(text.trim()); }}>
        <TextField label="Pincode or city" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
        <Button type="submit">Search</Button>
      </form>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title={place ? `No partner labs in “${place}” yet` : 'No partner labs available yet'}>Try another pincode or city.</Empty>
        : (
          <ul className="list">
            {q.data.map((lab) => {
              const home = lab.branches.some((b) => b.homeCollection);
              const visit = lab.branches.some((b) => b.inLab);
              const cities = [...new Set(lab.branches.map((b) => b.address?.city).filter(Boolean))];
              return (
                <li key={lab.partnerId}>
                  <Link to={`/labs/${lab.partnerId}`} className="list-row link-row">
                    <strong>{lab.name}</strong>
                    <span className="muted">{lab.branches.length === 1 ? lab.branches[0]!.name : `${lab.branches.length} branches`}{cities.length ? ` · ${cities.join(', ')}` : ''}</span>
                    <span>{[home ? 'Home collection' : '', visit ? 'Lab visit' : ''].filter(Boolean).join(' · ')}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
    </>
  );
}
