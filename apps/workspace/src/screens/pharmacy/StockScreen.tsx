import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { formatExpiry, inventoryApi, medicineName, sellableQty, type Batch, type InventoryItem } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { BatchActions } from './BatchActions.tsx';

const PAGE_SIZE = 20;

export const BATCH_STATUS_LABEL: Record<Batch['status'], string> = {
  active: 'On sale', depleted: 'Sold out', expired: 'Expired', recalled: 'Recalled', quarantined: 'Quarantined',
};
const batchTone = (s: Batch['status']) => (s === 'active' ? 'ok' : s === 'depleted' ? undefined : 'danger');

/** Find a medicine in this pharmacy's stock and act on its batches (P3/P3b). */
export function StockScreen() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const [text, setText] = useState(search);

  const q = useQuery({
    queryKey: ['pharmacy-inventory', 'list', search, page],
    queryFn: () => inventoryApi(api).list({ search: search || undefined, page, limit: PAGE_SIZE }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pharmacy-inventory'] });

  return (
    <>
      <PageHeading title="Stock">Find a medicine to see its batches, quarantine or release them, return them to a supplier or recall them.</PageHeading>
      <form className="ws-search" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setParams(text.trim() ? { q: text.trim() } : {}); }}>
        <TextField label="Medicine" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, brand or generic name" />
        <Button type="submit">Search</Button>
      </form>
      {q.isPending ? <Loading label="Loading stock…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title={search ? `Nothing in stock matches “${search}”` : 'No stock yet'} />
        : (
          <>
            <ul className="stock-list">
              {q.data.items.map((item) => <StockItem key={item._id} item={item} onChanged={refresh} />)}
            </ul>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={page <= 1}
                  onClick={() => setParams({ ...(search ? { q: search } : {}), page: String(page - 1) })}>Previous</Button>
                <span>Page {page} of {q.data.totalPages}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages}
                  onClick={() => setParams({ ...(search ? { q: search } : {}), page: String(page + 1) })}>Next</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}

function StockItem({ item, onChanged }: { item: InventoryItem; onChanged: () => Promise<unknown> }) {
  const sellable = sellableQty(item);
  const low = sellable <= item.reorderThreshold;
  const name = medicineName(item.medicineId);
  return (
    <li className="ws-section stock-item">
      <div className="stock-head">
        <h2>{name}</h2>
        <span>{sellable} sellable · {item.reservedQty} reserved{item.rackLocation ? ` · rack ${item.rackLocation}` : ''}</span>
        {low && <Badge tone="warn">Low: reorder at {item.reorderThreshold}</Badge>}
      </div>
      {(item.batches ?? []).length === 0 ? <span className="ws-muted">No batches recorded for this medicine.</span> : (
        <div className="ws-table-wrap">
          <table className="j-table">
            <caption className="j-sr-only">Batches of {name}</caption>
            <thead>
              <tr><th scope="col">Batch</th><th scope="col">Expiry</th><th scope="col">Unreserved</th><th scope="col">Reserved</th><th scope="col">Status</th><th scope="col">Actions</th></tr>
            </thead>
            <tbody>
              {item.batches!.map((b) => (
                <tr key={b._id}>
                  <td>{b.batchNumber}</td>
                  <td>{formatExpiry(b.expiryDate)}</td>
                  <td>{b.availableQty}</td>
                  <td>{b.reservedQty}</td>
                  <td>
                    <Badge tone={batchTone(b.status)}>{BATCH_STATUS_LABEL[b.status] ?? b.status}</Badge>
                    {b.holdReason && <div className="ws-muted">“{b.holdReason}”</div>}
                    {b.recallReference && <div className="ws-muted">Notice {b.recallReference}</div>}
                  </td>
                  <td><BatchActions itemId={item._id} batch={b} onChanged={onChanged} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}
