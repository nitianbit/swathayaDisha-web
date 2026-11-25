import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { inventoryApi, medicineName, sellableQty } from '@jansetu/api';
import { Button, Empty, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

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
      <PageHeading title={t('lowStock.lowStock')}>{t('lowStock.medicinesWhoseSellableStockIs')}</PageHeading>
      {q.isPending ? <Loading label={t('lowStock.loadingLowStock')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title={t('lowStock.nothingIsLow')}>{t('lowStock.everyMedicineIsAboveIts')}</Empty>
        : (
          <>
            <p className="ws-count">{t('lowStock.medicinesToReorderFull', { total: q.data.total })}</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <thead>
                  <tr><th scope={'col'}>{t('common.medicine')}</th><th scope={'col'}>{t('lowStock.sellable')}</th><th scope={'col'}>{t('lowStock.reorderAt')}</th><th scope={'col'}>{t('lowStock.refillsDueIn14Days')}</th></tr>
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
              <nav className="ws-pager" aria-label={t('common.pages')}>
                <Button variant="secondary" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}>{t('common.previous')}</Button>
                <span>{t('common.pageFull', { page, totalPages: q.data.totalPages })}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages} onClick={() => setParams({ page: String(page + 1) })}>{t('common.next')}</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}
