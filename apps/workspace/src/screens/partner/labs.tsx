import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import {
  hasGlobalScope, isDeskBooking, LAB_PAYMENT_STATUS_LABEL, LAB_VISIT_MODES, reportFileName, type Branch, type LabBooking, type LabBookingStatus, type VisitMode,
} from '@jansetu/api';
import { CALENDAR_DAY, formatDateWith } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { sniffDocument } from '../pharmacy/documents.ts';
import { useBranches, useWorkspacePartner, type ScopeContext } from './scope.tsx';

/** A calendar date (YYYY-MM-DD, already India time) as "Mon, 16 Nov 2026". */
export function formatDay(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return date;
  return formatDateWith(t, CALENDAR_DAY);
}

/** A slot as staff read it: its India-time day and times. */
/** r12: a desk walk-in has no seat: its arrival day and time, "walk-in". */
export const slotLabel = (s: { date: string; startTime: string; endTime?: string; walkIn?: boolean }) =>
  `${formatDay(s.date)}, ${s.startTime}${s.walkIn || !s.endTime ? ' (walk-in)' : `–${s.endTime}`}`;

/**
 * How a booking is paid, as a badge: r12 desk rows are paid at the lab ("Pay at lab"; no Jansetu payment), with the
 * number of the lab's bill once one is linked; online bookings show their payment status.
 */
export function LabPayment({ b }: { b: Pick<LabBooking, 'paymentStatus' | 'source' | 'payAtLab' | 'bill'> }) {
  if (isDeskBooking(b)) {
    return <><Badge>Pay at lab</Badge>{b.bill ? <> · Bill {b.bill.serial}{b.bill.state === 'cancelled' ? ' (cancelled)' : ''}</> : null}</>;
  }
  return <Badge tone={b.paymentStatus === 'paid' ? 'ok' : b.paymentStatus === 'refunded' ? 'danger' : 'warn'}>{LAB_PAYMENT_STATUS_LABEL[b.paymentStatus] ?? b.paymentStatus}</Badge>;
}

export const labStatusTone = (s: LabBookingStatus): 'ok' | 'warn' | 'danger' | undefined =>
  s === 'completed' || s === 'report_ready' ? 'ok' : s === 'cancelled' || s === 'no_show' ? 'danger' : s === 'pending_payment' ? 'warn' : undefined;

/** The visit modes a branch offers (`branchFor`: home collection or in-lab visits). */
export const modesOf = (b: Pick<Branch, 'services'>): VisitMode[] =>
  LAB_VISIT_MODES.filter((m) => (m === 'home' ? b.services?.homeCollection : b.services?.inLab));

/** Branches this actor works at (`assertBranchInScope`): every branch for owners/admins and unrestricted staff. */
export function useScopedBranches(ctx: ScopeContext) {
  const q = useBranches(ctx);
  const inScope = (q.data ?? []).filter((b) => b.isActive !== false && (hasGlobalScope(ctx.actor) || ctx.actor.branchIds.includes(b._id)));
  return { ...q, inScope };
}

/** The current time, moving every 30 seconds (some actions open only once a slot has started). */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Slots and lab bookings exist for lab partners only (admins may open any partner's URL). */
export function LabOnly({ ctx, children }: { ctx: ScopeContext; children: ReactNode }) {
  const partner = useWorkspacePartner(ctx);
  if (partner.isPending) return <Loading label="Loading…" />;
  if (partner.isError) return <ErrorState message={messageOf(partner.error)} onRetry={() => void partner.refetch()} />;
  if (partner.data?.kind !== 'lab') return <Empty title="Only for labs">Slots and lab bookings are kept by lab partners. {partner.data?.name ?? 'This partner'} is a clinic.</Empty>;
  return <>{children}</>;
}

/**
 * Opens report files of one booking: each is read with the session's token into an in-memory blob, bound to the file it
 * was asked for (a newer request or leaving cancels an older one), and shown only if it really is a PDF or an image.
 * No token or file link ever appears in a URL.
 */
export function useReportViewer(ctx: ScopeContext, bookingId: string) {
  const [shown, setShown] = useState<{ file: string; url: string; kind: 'pdf' | 'image' } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<{ file: string; message: string } | null>(null);
  const fetching = useRef<AbortController | null>(null);
  useEffect(() => () => { if (shown) URL.revokeObjectURL(shown.url); }, [shown]);
  useEffect(() => () => fetching.current?.abort(), []);

  async function open(file: string) {
    fetching.current?.abort();
    const ctrl = new AbortController();
    fetching.current = ctrl;
    setLoading(file);
    setError(null);
    setShown(null);
    try {
      const blob = await ctx.labs.reportFile(bookingId, file, ctrl.signal);
      const { kind, type } = await sniffDocument(blob);
      if (ctrl.signal.aborted) return;
      if (kind === 'other') { setError({ file, message: 'This file is not a PDF or an image, so it is not shown.' }); return; }
      setShown({ file, url: URL.createObjectURL(new Blob([blob], { type })), kind });
    } catch (err) {
      if (!ctrl.signal.aborted) setError({ file, message: messageOf(err) });
    } finally {
      if (fetching.current === ctrl) setLoading(null);
    }
  }
  const close = () => { fetching.current?.abort(); setShown(null); setLoading(null); };
  return { shown, loading, error, open, close };
}

export function ReportPreview({ viewer }: { viewer: ReturnType<typeof useReportViewer> }) {
  const { shown, error } = viewer;
  return (
    <>
      {error && <Alert>Could not open {reportFileName(error.file)}: {error.message}</Alert>}
      {shown && (
        <div className="rx-preview-wrap">
          <div className="rx-preview">
            {shown.kind === 'pdf'
              ? <div className="rx-pdf"><iframe src={shown.url} title={`Report ${reportFileName(shown.file)}`} /></div>
              : <img src={shown.url} alt={`Report ${reportFileName(shown.file)}`} />}
          </div>
          <div className="ws-actions">
            <a className="j-btn j-btn--secondary" href={shown.url} download={reportFileName(shown.file)}>Save {reportFileName(shown.file)}</a>
            <Button variant="ghost" onClick={viewer.close}>Close the preview</Button>
          </div>
        </div>
      )}
    </>
  );
}

export function ViewFileButton({ viewer, file }: { viewer: ReturnType<typeof useReportViewer>; file: string }) {
  return (
    <Button variant="secondary" busy={viewer.loading === file} aria-label={`View ${reportFileName(file)}`} onClick={() => void viewer.open(file)}>
      <FileText size={16} aria-hidden="true" /> View
    </Button>
  );
}
