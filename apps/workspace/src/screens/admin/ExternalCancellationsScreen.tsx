import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { adminQueuesApi, formatExpiry, type OpenCancellation } from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';

const PAGE_SIZE = 20;

const STATE_LABEL: Record<OpenCancellation['cancel']['state'], string> = {
  requested: 'Waiting to cancel at the provider',
  calling: 'Cancelling at the provider now',
  unknown: 'Provider outcome unknown',
};

/**
 * External bookings whose cancellation could not be proven automatically (A2b). The admin checks with the provider,
 * then records what the provider says; only then is the customer refunded.
 */
export function ExternalCancellationsScreen() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') === 'open' ? 'open' : 'admin';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const q = useQuery({
    queryKey: ['admin', 'external-cancellations', scope, page],
    queryFn: () => adminQueuesApi(api).openCancellations({ scope, page, limit: PAGE_SIZE }),
  });

  return (
    <>
      <PageHeading title="External cancellations">
        Lab and doctor bookings whose cancellation at the provider is not confirmed. No refund is made until it is.
      </PageHeading>
      <div className="ws-tabs" role="group" aria-label="Which cancellations">
        <Button variant={scope === 'admin' ? 'primary' : 'secondary'} aria-pressed={scope === 'admin'} onClick={() => setParams({})}>
          Waiting for an admin
        </Button>
        <Button variant={scope === 'open' ? 'primary' : 'secondary'} aria-pressed={scope === 'open'} onClick={() => setParams({ scope: 'open' })}>
          All open
        </Button>
      </div>
      {q.isPending ? <Loading label="Loading cancellations…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? (
          <Empty title={scope === 'admin' ? 'Nothing is waiting for an admin' : 'No open cancellations'} />
        ) : (
          <>
            <p className="ws-count">{q.data.total} {scope === 'admin' ? 'waiting for an admin' : 'open'}</p>
            <ul className="stock-list">{q.data.items.map((c) => <CancellationCard key={c._id} c={c} />)}</ul>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label="Pages">
                <Button variant="secondary" disabled={page <= 1}
                  onClick={() => setParams({ ...(scope === 'open' ? { scope } : {}), page: String(page - 1) })}>Previous</Button>
                <span>Page {page} of {q.data.totalPages}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages}
                  onClick={() => setParams({ ...(scope === 'open' ? { scope } : {}), page: String(page + 1) })}>Next</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}

function CancellationCard({ c }: { c: OpenCancellation }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const what = [c.labName ?? c.doctorName, ...(c.packageNames ?? []), ...(c.testNames ?? [])].filter(Boolean).join(' · ');
  const open = c.providerRefs.filter((r) => !r.cancelled);
  const reconcile = async (outcome: 'absent' | 'cancelled') => {
    try { await adminQueuesApi(api).reconcileCancellation(c._id, outcome); }
    finally { await queryClient.invalidateQueries({ queryKey: ['admin', 'external-cancellations'] }); }
  };

  return (
    <li className="ws-section">
      <div className="stock-head">
        <h2>{c.patientName ?? 'Patient'}</h2>
        <span>{c.integration} · {formatExpiry(c.bookingDate)} {c.bookingTime ?? ''} · {formatRupees(c.price)} {c.paymentStatus ?? ''}</span>
        <Badge tone={c.cancel.state === 'unknown' ? 'danger' : 'warn'}>{STATE_LABEL[c.cancel.state]}</Badge>
      </div>
      {what && <div className="ws-muted">{what}</div>}
      <dl className="ws-dl">
        <dt>Requested</dt><dd>{formatDateTime(c.cancel.at)} by {c.cancel.by}{c.cancel.reason ? ` — “${c.cancel.reason}”` : ''}</dd>
        <dt>Provider calls</dt><dd>{c.cancel.calls}{c.cancel.nextAt ? `, next ${formatDateTime(c.cancel.nextAt)}` : ''}</dd>
        {c.cancel.blockedBy && <><dt>Blocked by</dt><dd>{c.cancel.blockedBy.replace(/_/g, ' ')}</dd></>}
        {c.cancel.error && <><dt>Last error</dt><dd>{c.cancel.error}</dd></>}
        <dt>Provider bookings</dt>
        <dd>
          {c.providerRefs.length === 0 ? 'None recorded' : (
            <ul className="ws-list">
              {c.providerRefs.map((r) => (
                <li key={r.ref}><code>{r.ref}</code> {r.cancelled ? <Badge tone="ok">cancelled</Badge> : <Badge tone="warn">not confirmed</Badge>}</li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      {!c.cancel.needsAdmin ? (
        <span className="ws-muted">Still being retried automatically. Act only if the provider has already told you the outcome.</span>
      ) : (
        <Alert tone="warn">Check with {c.integration} before recording anything. What you record releases the refund.</Alert>
      )}
      <div className="ws-actions">
        {/* Always possible (reconcileProviderState): it also settles an attempt or a reschedule whose outcome is unknown. */}
        <ConfirmAction label="Provider confirms cancelled…" confirmLabel="Record: cancelled at the provider" danger
          consequence={<>You confirm that the provider holds no active booking for this: every booking it had
            {open.length ? <> (including <code>{open.map((r) => r.ref).join(', ')}</code>)</> : null}, also any made by a
            reschedule, is cancelled. The customer is then refunded.</>}
          onConfirm={() => reconcile('cancelled')} />
        {/* Refused by the backend while references exist (EXTERNAL_PROVIDER_REFERENCE_EXISTS). */}
        <ConfirmAction label="No booking at the provider…" confirmLabel="Record: no provider booking exists" danger
          disabled={c.providerRefs.length > 0}
          consequence="You confirm that the provider holds no booking for this at all. The customer is then refunded."
          onConfirm={() => reconcile('absent')} />
      </div>
      {c.providerRefs.length > 0 && (
        <span className="ws-muted">“No booking at the provider” is not possible while provider booking references exist.</span>
      )}
    </li>
  );
}
