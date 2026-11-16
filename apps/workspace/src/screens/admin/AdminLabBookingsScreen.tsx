import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  LAB_BOOKING_STATUS_LABEL, LAB_BOOKING_STATUSES, LAB_PAYMENT_STATUS_LABEL, LAB_VISIT_MODE_LABEL, labBookingsAdminApi,
  MAX_ADMIN_LAB_BOOKINGS, partnerAdminApi, type AdminLabBookingQuery, type LabBookingStatus,
} from '@jansetu/api';
import { Badge, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { labStatusTone, slotLabel } from '../partner/labs.tsx';

/** Admin: online lab bookings of every partner lab, newest booked first (the server answers at most 200). */
export function AdminLabBookingsScreen() {
  const { api } = useSession();
  const [partnerId, setPartnerId] = useState('');
  const [status, setStatus] = useState<'' | LabBookingStatus>('');
  const filter: AdminLabBookingQuery = { partnerId: partnerId || undefined, status: status || undefined };
  const list = useQuery({ queryKey: ['admin-lab-bookings', filter], queryFn: () => labBookingsAdminApi(api).list(filter) });
  // Names for the lab column and filter (labs only; the list's page size is 200, the largest the server gives).
  const labs = useQuery({ queryKey: ['admin-partners', 'labs'], queryFn: () => partnerAdminApi(api).list({ kind: 'lab', limit: 200 }) });
  const names = useMemo(() => new Map((labs.data?.items ?? []).map((p) => [p._id, p.name])), [labs.data]);
  const rows = list.data ?? [];

  return (
    <>
      <PageHeading title="Lab bookings">Online bookings at every partner lab, newest booked first. Open one to act on it as the lab’s owner.</PageHeading>
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="alb-lab">Lab</label>
          <select id="alb-lab" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            <option value="">All labs</option>
            {(labs.data?.items ?? []).map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
          {labs.isError && <span className="j-field__hint">Lab names could not be loaded: {messageOf(labs.error)}</span>}
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="alb-status">Status</label>
          <select id="alb-status" value={status} onChange={(e) => setStatus(e.target.value as '' | LabBookingStatus)}>
            <option value="">All</option>
            {LAB_BOOKING_STATUSES.map((s) => <option key={s} value={s}>{LAB_BOOKING_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      </div>
      {list.isPending ? <Loading label="Loading lab bookings…" />
        : list.isError ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title="No lab bookings">{partnerId || status ? 'No booking matches these filters.' : 'Bookings made in the app appear here.'}</Empty>
        : (
          <>
            <p className="ws-count">{rows.length} {rows.length === 1 ? 'booking' : 'bookings'}{rows.length >= MAX_ADMIN_LAB_BOOKINGS ? ` (the latest ${MAX_ADMIN_LAB_BOOKINGS}; filter by lab or status to see others)` : ''}</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Lab bookings of every lab</caption>
                <thead>
                  <tr><th scope="col">Booked</th><th scope="col">Lab</th><th scope="col">Slot</th><th scope="col">Patient</th><th scope="col">Visit</th><th scope="col">Status</th><th scope="col">Payment</th></tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b._id}>
                      <td><Link to={`/admin/partners/${b.partnerId}/lab-bookings/${b._id}`}>{formatDateTime(b.createdAt)}</Link></td>
                      <td>{names.get(b.partnerId) ?? `Lab …${b.partnerId.slice(-6)}`}</td>
                      <td>{b.slot ? slotLabel(b.slot) : '—'}</td>
                      <td>{b.patient?.name}</td>
                      <td>{LAB_VISIT_MODE_LABEL[b.visitMode] ?? b.visitMode}</td>
                      <td>
                        <Badge tone={labStatusTone(b.status)}>{LAB_BOOKING_STATUS_LABEL[b.status] ?? b.status}</Badge>
                        {b.reschedule?.pending && <> <Badge tone="warn">New time proposed</Badge></>}
                      </td>
                      <td>{LAB_PAYMENT_STATUS_LABEL[b.paymentStatus] ?? b.paymentStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
    </>
  );
}
