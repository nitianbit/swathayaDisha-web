import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { customerBillsApi, fromPaise, type BillState } from '@jansetu/api';
import { Badge, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { messageOf, PageHeading } from '../../common.tsx';
import { useSession } from '../../session.tsx';

export const BILL_STATE: Record<BillState, { label: string; tone?: 'ok' | 'warn' | 'danger' }> = {
  issued: { label: 'Unpaid', tone: 'warn' },
  paid: { label: 'Paid', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

/** Bills from partner labs and clinics, issued to this account's phone number. */
export function BillsScreen() {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['bills'], queryFn: () => customerBillsApi(api).bills() });
  return (
    <>
      <PageHeading title="Bills">Bills from partner labs and clinics you visited.</PageHeading>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title="No bills yet">Bills from partner labs and clinics appear here when they use your mobile number.</Empty>
        : (
          <ul className="list">
            {q.data.map((b) => {
              const s = BILL_STATE[b.lifecycleState] ?? { label: b.lifecycleState };
              return (
                <li key={b._id}>
                  <Link to={`/bills/${b._id}`} className="list-row link-row">
                    <strong>{b.supplier?.name ?? 'Bill'}</strong>
                    <span className="muted">{b.serial} · {formatDateTime(b.issuedAt)}</span>
                    <span><Badge tone={s.tone}>{s.label}</Badge> <span className="muted">{formatRupees(fromPaise(b.totals?.totalMinor))}</span></span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
    </>
  );
}
