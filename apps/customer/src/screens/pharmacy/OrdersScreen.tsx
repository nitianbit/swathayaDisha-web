import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { customerPharmacyApi } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { usePagedList } from '../../paging.ts';
import { useSession } from '../../session.tsx';
import { ORDER_STATUS, orderTitle } from './labels.ts';

/** The customer's own pharmacy orders, newest first (the server scopes the list to the signed-in customer). */
export function PharmacyOrdersScreen() {
  const { api } = useSession();
  const { q, items, total } = usePagedList(['pharmacy-orders', 'mine'], (page) => customerPharmacyApi(api).orders(page));
  return (
    <>
      <Link to="/pharmacy" className="back"><ArrowLeft size={16} aria-hidden="true" /> Medicines</Link>
      <PageHeading title="My medicine orders" />
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <Empty title="No medicine orders yet"><Link to="/pharmacy">Order medicines</Link></Empty>
        : (
          <>
            <ul className="list">
              {items.map((o) => {
                const s = ORDER_STATUS[o.status] ?? { label: o.status };
                return (
                  <li key={o._id}>
                    <Link to={`/pharmacy/orders/${o._id}`} className="list-row link-row">
                      <strong>{orderTitle(o)}</strong>
                      <span className="muted">{formatDateTime(o.createdAt)} · {o.items.length} {o.items.length === 1 ? 'medicine' : 'medicines'} · {formatRupees(o.grandTotal)}</span>
                      <span><Badge tone={s.tone}>{s.label}</Badge></span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <p className="muted">Showing {items.length} of {total}.</p>
            {q.hasNextPage && <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Show more</Button>}
          </>
        )}
    </>
  );
}
