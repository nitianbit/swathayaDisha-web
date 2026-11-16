import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  addDays, isRealDate, istDateOf, LAB_BOOKING_STATUS_LABEL, LAB_BOOKING_STATUSES, LAB_PAYMENT_STATUS_LABEL, LAB_VISIT_MODE_LABEL,
  MAX_LAB_BOOKINGS, type LabBookingQuery, type LabBookingStatus,
} from '@jansetu/api';
import { Badge, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { LabOnly, labStatusTone, slotLabel, useScopedBranches } from './labs.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

/** Online bookings at this lab's branches (`bookings.view`, `bookings.manage`, `reports.upload` or `reports.release`). */
export function LabBookingsScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: filters never carry over to another partner.
  return <LabBookings key={scopeIdentity(ctx)} ctx={ctx} />;
}

function LabBookings({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Lab bookings" partnerName={partner.data?.name}>
        Tests customers booked and paid for in the Jansetu app, by slot time. Times are India time.
      </PartnerPageHeading>
      {ctx.adminHome && <div><Link to={ctx.link('slots')}>Slots of this lab</Link></div>}
      <LabOnly ctx={ctx}><BookingList ctx={ctx} /></LabOnly>
    </>
  );
}

function BookingList({ ctx }: { ctx: ScopeContext }) {
  const branches = useScopedBranches(ctx);
  const [status, setStatus] = useState<'' | LabBookingStatus>('');
  const [branchId, setBranchId] = useState('');
  // The list is oldest slot first with no paging: by default from a week back, so current work is not cut off.
  const [from, setFrom] = useState(() => addDays(istDateOf(new Date()), -7));
  const [to, setTo] = useState('');
  const filter: LabBookingQuery = {
    status: status || undefined, branchId: branchId || undefined,
    from: isRealDate(from) ? from : undefined, to: isRealDate(to) ? to : undefined, limit: MAX_LAB_BOOKINGS,
  };
  const dateError = filter.from && filter.to && filter.from > filter.to ? 'The end date is before the start date.' : null;
  const list = useQuery({
    queryKey: [...ctx.key, 'lab-bookings', filter], queryFn: () => ctx.labs.bookings(filter), enabled: !dateError,
  });
  const names = useMemo(() => new Map((branches.data ?? []).map((b) => [b._id, b.name])), [branches.data]);
  const rows = list.data ?? [];

  return (
    <>
      <div className="ws-search">
        <div className="j-field ws-filter">
          <label htmlFor="lb-branch">Branch</label>
          <select id="lb-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">All your branches</option>
            {branches.inScope.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <div className="j-field ws-filter">
          <label htmlFor="lb-status">Status</label>
          <select id="lb-status" value={status} onChange={(e) => setStatus(e.target.value as '' | LabBookingStatus)}>
            <option value="">All</option>
            {LAB_BOOKING_STATUSES.map((s) => <option key={s} value={s}>{LAB_BOOKING_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <TextField label="Slot from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="Slot until" type="date" value={to} error={dateError} onChange={(e) => setTo(e.target.value)} />
      </div>
      {dateError ? null
        : list.isPending ? <Loading label="Loading bookings…" />
        : list.isError ? <ErrorState message={messageOf(list.error)} onRetry={() => void list.refetch()} />
        : rows.length === 0 ? <Empty title="No bookings">No booking matches these filters.</Empty>
        : (
          <>
            <p className="ws-count">{rows.length} {rows.length === 1 ? 'booking' : 'bookings'}{rows.length >= MAX_LAB_BOOKINGS ? ` (the first ${MAX_LAB_BOOKINGS}; narrow the dates to see later ones)` : ''}</p>
            <div className="ws-table-wrap">
              <table className="j-table">
                <caption className="j-sr-only">Lab bookings</caption>
                <thead>
                  <tr><th scope="col">Slot</th><th scope="col">Patient</th><th scope="col">Tests</th><th scope="col">Visit</th><th scope="col">Branch</th><th scope="col">Status</th><th scope="col">Payment</th></tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b._id}>
                      <td><Link to={`${ctx.link('lab-bookings')}/${b._id}`}>{slotLabel(b.slot)}</Link></td>
                      <td>{b.patient?.name}</td>
                      <td>{b.items.map((i) => i.name).join(', ')}</td>
                      <td>{LAB_VISIT_MODE_LABEL[b.visitMode] ?? b.visitMode}</td>
                      <td>{names.get(b.branchId) ?? `Branch …${b.branchId.slice(-6)}`}</td>
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
