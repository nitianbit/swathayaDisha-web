import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { inventoryApi, medicineName, sellableQty } from '@jansetu/api';
import { Button, Empty, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';

const PAGE_SIZE = 50;

/** Medicines at or below their reorder level (P7c), with refills due soon. */
export function LowStockScreen() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const q = useQuery({
    queryKey: ['pharmacy-inventory', 'low-stock', page],
    queryFn: () => inventoryApi(api).lowStock({ page, limit: PAGE_SIZE }),
    refetchInterval: 5 * 60_000,
  });

  return (
    <>
      <PageHeading title="Low stock">Medicines whose sellable stock is at or below the reorder level. Expired and held batches do not count.</PageHeading>
      {q.isPending ? <Loading label="Loading low stock…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title="Nothing is low">Every medicine is above its reorder level.</Empty>
        : (
          <>
            <p className="ws-count">{q.data.total} medicines to reorder</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <thead>
                  <tr><th scope="col">Medicine</th><th scope="col">Sellable</th><th scope="col">Reorder at</th><th scope="col">Refills due in 14 days</th></tr>
                </thead>
                <tbody>
                  {q.data.items.map((item) => {
                    const name = medicineName(item.medicineId);
                    const term = typeof item.medicineId === 'object' && item.medicineId?.name ? item.medicineId.name : name;
                    return (
                      <tr key={item._id}>
                        <td><Link to={`/pharmacy/stock?q=${encodeURIComponent(term)}`}>{name}</Link></td>
                        <td>{sellableQty(item)}</td>
                        <td>{item.reorderThreshold}</td>
                        <td>{typeof item.upcomingRefills === 'number' ? item.upcomingRefills : 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}>Previous</Button>
                <span>Page {page} of {q.data.totalPages}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages} onClick={() => setParams({ page: String(page + 1) })}>Next</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}
