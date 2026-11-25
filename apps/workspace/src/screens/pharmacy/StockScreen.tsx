import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { formatExpiry, inventoryApi, medicineName, sellableQty, type Batch, type InventoryItem } from '@jansetu/api';
import { Badge, Button, Empty, ErrorState, Loading, shared, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { BatchActions } from './BatchActions.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

const PAGE_SIZE = 20;

export const BATCH_STATUS_LABEL = (): Record<Batch['status'], string> => ({
  active: t('stock.onSale'), depleted: t('stock.soldOut'), expired: 'Expired', recalled: 'Recalled', quarantined: 'Quarantined',
});
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
      <PageHeading title={t('stock.stock')}>{t('stock.findAMedicineToSee')}</PageHeading>
      <div className="ws-actions">
        <Link className="j-btn j-btn--primary" to="/pharmacy/stock/add">{t('common.addStock')}</Link>
        <Link className="j-btn j-btn--secondary" to="/pharmacy/stock/import">{t('common.importStockFromAFile')}</Link>
      </div>
      <form className="ws-search" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); setParams(text.trim() ? { q: text.trim() } : {}); }}>
        <TextField label={t('common.medicine')} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('common.nameBrandOrGenericName')} />
        <Button type="submit">{shared('action.search')}</Button>
      </form>
      {q.isPending ? <Loading label={t('stock.loadingStock')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? (
          <Empty title={search ? t('stock.nothingInStockMatches', { search }) : t('stock.noStockYet')}>{t('stock.addStockForOneBatch')}</Empty>
        )
        : (
          <>
            <ul className="stock-list">
              {q.data.items.map((item) => <StockItem key={item._id} item={item} onChanged={refresh} />)}
            </ul>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label={t('common.pages')}>
                <Button variant="secondary" disabled={page <= 1}
                  onClick={() => setParams({ ...(search ? { q: search } : {}), page: String(page - 1) })}>{t('common.previous')}</Button>
                <span>{t('common.pageFull', { page, totalPages: q.data.totalPages })}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages}
                  onClick={() => setParams({ ...(search ? { q: search } : {}), page: String(page + 1) })}>{t('common.next')}</Button>
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
        <span>{t('stock.sellableFull', { sellable, reservedQty: item.reservedQty, value: item.rackLocation ? ` · rack ${item.rackLocation}` : '' })}</span>
        {low && <Badge tone="warn">{t('stock.lowReorderAtFull', { reorderThreshold: item.reorderThreshold })}</Badge>}
        {typeof item.medicineId === 'object' && /^[0-9a-fA-F]{24}$/.test(item.medicineId._id) && (
          <Link to={`/pharmacy/stock/add?medicine=${item.medicineId._id}`} aria-label={t('stock.addABatchOf', { name })}>{t('stock.addABatch')}</Link>
        )}
      </div>
      {(item.batches ?? []).length === 0 ? <span className="ws-muted">{t('stock.noBatchesRecordedForThis')}</span> : (
        <div className="ws-table-wrap">
          <table className="j-table">
            <caption className="j-sr-only">{t('stock.batchesOfFull', { name })}</caption>
            <thead>
              <tr><th scope={'col'}>{t('common.batch')}</th><th scope={'col'}>{t('common.expiry')}</th><th scope={'col'}>{t('common.unreserved')}</th><th scope={'col'}>{t('common.reserved')}</th><th scope={'col'}>{t('common.status')}</th><th scope={'col'}>{t('common.actions')}</th></tr>
            </thead>
            <tbody>
              {item.batches!.map((b) => (
                <tr key={b._id}>
                  <td>{b.batchNumber}</td>
                  <td>{formatExpiry(b.expiryDate)}</td>
                  <td>{b.availableQty}</td>
                  <td>{b.reservedQty}</td>
                  <td>
                    <Badge tone={batchTone(b.status)}>{BATCH_STATUS_LABEL()[b.status] ?? b.status}</Badge>
                    {b.holdReason && <div className="ws-muted">“{b.holdReason}”</div>}
                    {b.recallReference && <div className="ws-muted">{t('stock.noticeFull', { recallReference: b.recallReference })}</div>}
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
