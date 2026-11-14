import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { pharmacyOrdersApi, type PharmacyOrder } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';

const PAGE_SIZE = 20;

const customerName = (c: PharmacyOrder['customerId']) =>
  c && typeof c === 'object' && c.name ? c.name : '—';

/** Prescription orders this pharmacy sells that wait for its pharmacist (P1); the backend scopes and filters the list. */
export function RxQueueScreen() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);

  const q = useQuery({
    queryKey: ['pharmacy-orders', 'rx-queue', page],
    // Seller-only, reviewable-state queue (backend W1); oldest first, so the longest-waiting customer comes first.
    queryFn: () => pharmacyOrdersApi(api).reviewQueue({ page, limit: PAGE_SIZE }),
    refetchInterval: 60_000,
  });

  return (
    <>
      <PageHeading title="Prescription review">
        Orders that need a pharmacist to check the prescription before they can be packed.
      </PageHeading>
      {q.isPending ? <Loading label="Loading prescriptions…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? (
          <Empty title="No prescriptions waiting">New prescription orders will appear here.</Empty>
        ) : (
          <>
            <p className="ws-count" aria-live="polite">{q.data.total} waiting</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Placed</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Items</th>
                    <th scope="col">Total</th>
                    <th scope="col">Payment</th>
                    <th scope="col">Documents</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((o) => (
                    <tr key={o._id}>
                      <td><Link to={`/pharmacy/prescriptions/${o._id}`}>{o.orderNumber ?? o._id.slice(-8)}</Link></td>
                      <td>{formatDateTime(o.createdAt)}</td>
                      <td>{customerName(o.customerId)}</td>
                      <td>{o.items?.length ?? 0}</td>
                      <td>{formatRupees(o.grandTotal)}</td>
                      <td><Badge tone={o.paymentStatus === 'paid' ? 'ok' : undefined}>{o.paymentStatus ?? 'pending'}</Badge></td>
                      <td>{o.prescriptionUrls?.length ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}>
                  Previous
                </Button>
                <span>Page {page} of {q.data.totalPages}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages}
                  onClick={() => setParams({ page: String(page + 1) })}>
                  Next
                </Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}
