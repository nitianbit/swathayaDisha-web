import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { adminQueuesApi, ApiError, formatExpiry, type OpenCancellation } from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, formatRupees, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';

const PAGE_SIZE = 20;

const STATE_LABEL = {
  requested: 'externalCancellations.state.requested',
  calling: 'externalCancellations.state.calling',
  unknown: 'externalCancellations.state.unknown',
} as const satisfies Record<OpenCancellation['cancel']['state'], string>;

/**
 * External bookings whose cancellation could not be proven automatically (A2b). The admin checks with the provider,
 * then records what the provider says; only then is the customer refunded.
 */
export function ExternalCancellationsScreen() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') === 'open' ? 'open' : 'admin';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  // Bookings whose obligations changed under an open review: their cards say so until the admin re-checks.
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set());
  const q = useQuery({
    queryKey: ['admin', 'external-cancellations', scope, page],
    queryFn: () => adminQueuesApi(api).openCancellations({ scope, page, limit: PAGE_SIZE }),
  });

  return (
    <>
      <PageHeading title={t('externalCancellations.title')}>{t('externalCancellations.intro')}</PageHeading>
      <div className="ws-tabs" role="group" aria-label={t('externalCancellations.which')}>
        <Button variant={scope === 'admin' ? 'primary' : 'secondary'} aria-pressed={scope === 'admin'} onClick={() => setParams({})}>
          {t('externalCancellations.waitingAdmin')}
        </Button>
        <Button variant={scope === 'open' ? 'primary' : 'secondary'} aria-pressed={scope === 'open'} onClick={() => setParams({ scope: 'open' })}>
          {t('externalCancellations.allOpen')}
        </Button>
      </div>
      {q.isPending ? <Loading label={t('externalCancellations.loading')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : q.data.items.length === 0 ? (
          <Empty title={scope === 'admin' ? t('externalCancellations.noneWaiting') : t('externalCancellations.noneOpen')} />
        ) : (
          <>
            <p className="ws-count">{t(scope === 'admin' ? 'externalCancellations.countWaiting' : 'externalCancellations.countOpen', { count: q.data.total })}</p>
            <ul className="stock-list">
              {q.data.items.map((c) => (
                // Keyed by the obligations: if they change, the card (and any open confirmation) starts over.
                <CancellationCard key={`${c._id}:${c.obligations}`} c={c} changed={changed.has(c._id)}
                  onChanged={() => setChanged((s) => new Set(s).add(c._id))}
                  onReviewed={() => setChanged((s) => { const n = new Set(s); n.delete(c._id); return n; })} />
              ))}
            </ul>
            {q.data.totalPages > 1 && (
              <nav className="ws-pager" aria-label={t('common.pages')}>
                <Button variant="secondary" disabled={page <= 1}
                  onClick={() => setParams({ ...(scope === 'open' ? { scope } : {}), page: String(page - 1) })}>{t('common.previous')}</Button>
                <span>{t('common.pageOf', { page, lastPage: q.data.totalPages })}</span>
                <Button variant="secondary" disabled={page >= q.data.totalPages}
                  onClick={() => setParams({ ...(scope === 'open' ? { scope } : {}), page: String(page + 1) })}>{t('common.next')}</Button>
              </nav>
            )}
          </>
        )}
    </>
  );
}

function CancellationCard({ c, changed, onChanged, onReviewed }:
  { c: OpenCancellation; changed: boolean; onChanged: () => void; onReviewed: () => void }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const what = [c.labName ?? c.doctorName, ...(c.packageNames ?? []), ...(c.testNames ?? [])].filter(Boolean).join(' · ');
  const open = c.providerRefs.filter((r) => !r.cancelled);
  const reconcile = async (outcome: 'absent' | 'cancelled') => {
    try {
      // Attests exactly the obligations on this card; refused if they changed since it was loaded.
      await adminQueuesApi(api).reconcileCancellation(c._id, outcome, c.obligations);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EXTERNAL_OBLIGATIONS_CHANGED') onChanged();
      throw err;
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'external-cancellations'] });
    }
  };

  return (
    <li className="ws-section">
      <div className="stock-head">
        <h2>{c.patientName ?? t('externalCancellations.patient')}</h2>
        <span>{c.integration} · {formatExpiry(c.bookingDate)} {c.bookingTime ?? ''} · {formatRupees(c.price)} {c.paymentStatus ?? ''}</span>
        <Badge tone={c.cancel.state === 'unknown' ? 'danger' : 'warn'}>{t(STATE_LABEL[c.cancel.state])}</Badge>
      </div>
      {what && <div className="ws-muted">{what}</div>}
      <dl className="ws-dl">
        <dt>{t('externalCancellations.requested')}</dt>
        <dd>{c.cancel.reason ? t('externalCancellations.requestedByReason', { at: formatDateTime(c.cancel.at), by: c.cancel.by, reason: c.cancel.reason })
          : t('externalCancellations.requestedBy', { at: formatDateTime(c.cancel.at), by: c.cancel.by })}</dd>
        <dt>{t('externalCancellations.calls')}</dt>
        <dd>{c.cancel.nextAt ? t('externalCancellations.callsNext', { calls: c.cancel.calls, at: formatDateTime(c.cancel.nextAt) }) : c.cancel.calls}</dd>
        {c.cancel.blockedBy && <><dt>{t('externalCancellations.blockedBy')}</dt><dd>{c.cancel.blockedBy.replace(/_/g, ' ')}</dd></>}
        {c.cancel.error && <><dt>{t('externalCancellations.lastError')}</dt><dd>{c.cancel.error}</dd></>}
        <dt>{t('externalCancellations.providerBookings')}</dt>
        <dd>
          {c.providerRefs.length === 0 ? t('externalCancellations.noneRecorded') : (
            <ul className="ws-list">
              {c.providerRefs.map((r) => (
                <li key={r.ref}><code>{r.ref}</code> {r.cancelled ? <Badge tone="ok">{t('externalCancellations.ref.cancelled')}</Badge> : <Badge tone="warn">{t('externalCancellations.ref.notConfirmed')}</Badge>}</li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      {changed && (
        <Alert>
          {t('externalCancellations.changed')}{' '}
          <Button variant="ghost" onClick={onReviewed}>{t('externalCancellations.checked')}</Button>
        </Alert>
      )}
      {!c.cancel.needsAdmin ? (
        <span className="ws-muted">{t('externalCancellations.retrying')}</span>
      ) : (
        <Alert tone="warn">{t('externalCancellations.checkWith', { provider: c.integration })}</Alert>
      )}
      <div className="ws-actions">
        {/* Always possible (reconcileProviderState): it also settles an attempt or a reschedule whose outcome is unknown. */}
        <ConfirmAction label={t('externalCancellations.confirmsCancelled')} confirmLabel={t('externalCancellations.recordCancelled')} danger disabled={changed}
          consequence={open.length
            ? <>{t.rich('externalCancellations.cancelledConsequenceRefs', { refs: <code key="refs">{open.map((r) => r.ref).join(', ')}</code> })}</>
            : t('externalCancellations.cancelledConsequence')}
          onConfirm={() => reconcile('cancelled')} />
        {/* Refused by the backend while references exist (EXTERNAL_PROVIDER_REFERENCE_EXISTS). */}
        <ConfirmAction label={t('externalCancellations.noBooking')} confirmLabel={t('externalCancellations.recordAbsent')} danger
          disabled={changed || c.providerRefs.length > 0}
          consequence={t('externalCancellations.absentConsequence')}
          onConfirm={() => reconcile('absent')} />
      </div>
      {c.providerRefs.length > 0 && (
        <span className="ws-muted">{t('externalCancellations.absentImpossible')}</span>
      )}
    </li>
  );
}
