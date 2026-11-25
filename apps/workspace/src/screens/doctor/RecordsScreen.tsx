import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FileText } from 'lucide-react';
import {
  ApiError, APPOINTMENT_STATUS_LABEL, CONSULT_MODE_LABEL, doctorRecordsApi, formatSlotDate, OBJECT_ID_PATTERN, recordsAccessState, recordsErrorCode,
  type OtherConsultation, type OtherLabReport, type RecordsRequestAnswer, type TreatingRecords,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/records/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { DocumentPreview, useDocumentViewer } from '../pharmacy/documentViewer.tsx';
import { CheckPanel, useOwnedOp } from '../pharmacy/ownedOp.tsx';
import { NotADoctor, useDoctor, type DoctorContext } from './doctor.tsx';

/**
 * WQ28: a doctor's patient records for one of its consultations (assisted booking round 3f, backend r30, design §25.17),
 * `/doctor/appointments/:bookingId/records` (an id only in the address). The doctor's own consultations with that person,
 * and, once the account holder allows it in the customer app, their prescriptions from other doctors and released lab
 * reports, each opened through `/file/fetch` (the full PDF; the server logs every read). "Ask the patient" is one owned
 * request (stored before it is sent; an unknown answer is checked by reading the page again). Words: the `records` catalogue.
 */
export function RecordsScreen() {
  const d = useDoctor();
  const { bookingId = '' } = useParams();
  if (!d) return <NotADoctor />;
  return (
    <>
      <Link to="/doctor/appointments" className="ws-back"><ArrowLeft size={16} aria-hidden="true" /> {t('page.back')}</Link>
      <PageHeading title={t('page.title')}>{t('page.intro')}</PageHeading>
      {OBJECT_ID_PATTERN.test(bookingId) ? <Records key={`${d.identity}:${bookingId}`} d={d} bookingId={bookingId} /> : <NotFound />}
    </>
  );
}

function NotFound() {
  return <Empty title={t('notFound.title')}><Link to="/doctor/appointments">{t('notFound.back')}</Link></Empty>;
}

/** The server's refusal in words: the catalogue's for its code (`error.<code>`), else the server's message. */
function words(err: unknown): string {
  const key = `error.${recordsErrorCode(err) ?? ''}`;
  return t.has(key) ? t(key) : messageOf(err);
}
/** WQ28b: for `ConfirmAction` (which shows an `ApiError`'s message): the refusal in words, without its code. */
const worded = (err: unknown) => new ApiError(err instanceof ApiError ? err.status : 0, words(err));

const recordsKey = (d: DoctorContext, bookingId: string) => [...d.key, 'records', bookingId];

function Records({ d, bookingId }: { d: DoctorContext; bookingId: string }) {
  const { api } = useSession();
  // Every read is logged by the server: read on opening, after asking and on "Check again", never on focus or reconnect.
  const q = useQuery({ queryKey: recordsKey(d, bookingId), queryFn: () => doctorRecordsApi(api).treating(bookingId),
    refetchOnWindowFocus: false, refetchOnReconnect: false });
  if (q.isPending) return <Loading />;
  if (q.isError && q.data === undefined) {
    const code = recordsErrorCode(q.error);
    if (code === 'BOOKING_NOT_FOUND' || code === 'PATIENT_HISTORY_NOT_FOUND') return <NotFound />;
    if (code === 'TREATING_WINDOW_CLOSED' || code === 'SPECIALIST_NOT_VERIFIED') return <Alert tone="warn">{words(q.error)}</Alert>;
    return <ErrorState message={words(q.error)} onRetry={() => void q.refetch()} />;
  }
  const r = q.data!;
  return (
    <>
      {q.isError && <Alert>{words(q.error)}</Alert>}
      <OwnConsultations r={r} />
      <OtherRecords d={d} bookingId={bookingId} r={r} reading={q.isFetching} reread={() => q.refetch()} />
    </>
  );
}

function OwnConsultations({ r }: { r: TreatingRecords }) {
  return (
    <section className="ws-section" aria-labelledby="own-h">
      <h2 id="own-h">{t('own.title')}</h2>
      <div className="ws-table-wrap">
        <table className="j-table">
          <caption className="j-sr-only">{t('own.caption')}</caption>
          <thead><tr><th scope="col">{t('own.when')}</th><th scope="col">{t('own.type')}</th><th scope="col">{t('own.status')}</th></tr></thead>
          <tbody>
            {r.consultations.map((b) => (
              <tr key={b.bookingId}>
                <td>{t('own.at', { date: formatSlotDate(b.bookingDate), time: b.bookingTime })}</td>
                <td>{b.consultationMode ? CONSULT_MODE_LABEL[b.consultationMode as keyof typeof CONSULT_MODE_LABEL] ?? b.consultationMode : t('others.unknown')}</td>
                <td>{APPOINTMENT_STATUS_LABEL[b.status as keyof typeof APPOINTMENT_STATUS_LABEL] ?? b.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** WQ28b: the records are seen until the earlier of the grant's end and this consultation's treating end. */
function seenUntil(r: TreatingRecords): string | null {
  const ends = [r.access.grant?.expiresAt, r.access.window.closesAt].filter((x): x is string => !!x && Number.isFinite(Date.parse(x)));
  return ends.length ? ends.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

function OtherRecords({ d, bookingId, r, reading, reread }: {
  d: DoctorContext; bookingId: string; r: TreatingRecords; reading: boolean; reread: () => Promise<unknown>;
}) {
  const state = recordsAccessState(r.access);
  const [note, setNote] = useState<string | null>(null);
  const shown = state === 'approved' && r.others;
  let status: ReactNode = null;
  if (state === 'pending') {
    status = (
      <Alert tone="warn">
        {t('state.pending', { until: formatDateTime(r.access.request!.expiresAt) })}{' '}
        <Button variant="secondary" busy={reading} onClick={() => { setNote(null); void reread(); }}>{t('state.check')}</Button>
      </Alert>
    );
  } else if (state === 'denied') status = <Alert tone="warn">{t('state.denied')}</Alert>;
  else if (state === 'expired') status = <Alert tone="warn">{t('state.expired')}</Alert>;
  else if (state === 'approved' && !r.others) status = <Alert tone="warn">{t('state.off')}</Alert>;
  return (
    <section className="ws-section" aria-labelledby="others-h">
      <h2 id="others-h">{t('others.title')}</h2>
      {r.access.identityNote && <p className="ws-muted">{t('identity')}</p>}
      {note && <Alert tone="ok">{note}</Alert>}
      {shown ? (
        <>
          <p className="ws-muted">{t('state.approved', { until: formatDateTime(seenUntil(r) ?? '') })}</p>
          <OthersList consultations={r.others!.consultations} labReports={r.others!.labReports} />
        </>
      ) : (
        <>
          <p>{t('others.ownOnly')}</p>
          {status}
          {state === 'none' && <p className="ws-muted">{t('others.why')}</p>}
          {state !== 'pending' && state !== 'approved' && (
            <AskPatient d={d} bookingId={bookingId} reread={reread}
              onAsked={(a) => setNote(a.state === 'approved' ? t('ask.alreadyAllowed') : !a.channels.app ? `${t('ask.sent')} ${t('ask.noApp')}` : t('ask.sent'))} />
          )}
        </>
      )}
    </section>
  );
}

/** One list, newest first: other doctors' prescriptions and released lab reports; "Open" reads the file (logged). */
function OthersList({ consultations, labReports }: { consultations: OtherConsultation[]; labReports: OtherLabReport[] }) {
  const viewer = useDocumentViewer();
  const rows = [
    ...consultations.map((c) => ({ key: `c:${c.bookingId}`, ymd: c.date ?? '', from: c.doctorName && c.specialization ? t('others.doctorWith', { name: c.doctorName, specialization: c.specialization }) : c.doctorName,
      what: t('others.prescription'), files: c.prescriptionFile ? [c.prescriptionFile] : [] })),
    ...labReports.map((l) => ({ key: `l:${l.labBookingId}`, ymd: (l.date ?? '').replace(/-/g, ''), from: l.labName,
      what: t('others.labReport', { tests: l.tests.join(', ') }), files: l.releases.map((x) => x.file) })),
  ].sort((a, b) => b.ymd.localeCompare(a.ymd));
  if (rows.length === 0) return <Empty title={t('others.none')} />;
  return (
    <>
      <div className="ws-table-wrap">
        <table className="j-table">
          <caption className="j-sr-only">{t('others.caption')}</caption>
          <thead>
            <tr><th scope="col">{t('others.date')}</th><th scope="col">{t('others.from')}</th><th scope="col">{t('others.type')}</th><th scope="col">{t('others.open')}</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const date = row.ymd ? formatSlotDate(row.ymd) : t('others.unknown');
              return (
                <tr key={row.key}>
                  <td>{date}</td>
                  <td>{row.from ?? t('others.unknown')}</td>
                  <td>{row.what}</td>
                  <td>
                    {row.files.length === 0 ? <span className="ws-muted">{t('others.noFile')}</span> : (
                      <div className="ws-actions">
                        {row.files.map((f, i) => (
                          <Button key={f} variant="secondary" busy={viewer.opening === f} onClick={() => void viewer.open(f)}
                            aria-label={row.files.length > 1 ? t('others.openPartFor', { n: i + 1, what: row.what, date }) : t('others.openOne', { what: row.what, date })}>
                            <FileText size={16} aria-hidden="true" /> {row.files.length > 1 ? t('others.openPart', { n: i + 1 }) : t('others.open')}
                          </Button>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {viewer.error && <Alert>{t('viewer.failed', { error: viewer.error })}</Alert>}
      <DocumentPreview preview={viewer.preview} title={t('viewer.title')} noun={t('viewer.noun')} fileName={t('viewer.noun')} />
    </>
  );
}

interface PendingAsk { bookingId: string }

/**
 * `POST /specialists/me/bookings/:id/records-access/request` as one owned request: stored before it is sent, settled
 * only by its own live answer. An unknown outcome is checked by reading the page again (a request or a grant found).
 */
function AskPatient({ d, bookingId, reread, onAsked }: {
  d: DoctorContext; bookingId: string; reread: () => Promise<unknown>; onAsked: (a: RecordsRequestAnswer) => void;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const { op, send, settle } = useOwnedOp<PendingAsk>(`records-request:${d.identity}:${bookingId}`);
  const { perform, busy } = useOneAtATime('records');
  const [resendError, setResendError] = useState<string | null>(null);

  async function ask(p: PendingOp<PendingAsk>) {
    const r = await perform(() => send(p, (b) => doctorRecordsApi(api).request(b.bookingId)));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') { onAsked(r.value); await reread(); return; }
    if (r.kind === 'refused') throw worded(r.error);
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {resendError && <Alert>{resendError}</Alert>}
        <CheckPanel label={t('ask.panel')}
          onCheck={async () => {
            const now = await doctorRecordsApi(api).treating(bookingId);
            // WQ28b: this read is the page's too (each read is logged once).
            queryClient.setQueryData(recordsKey(d, bookingId), now);
            const state = recordsAccessState(now.access);
            const asked = now.access.request && Date.parse(now.access.request.createdAt) >= op.firstAttemptAt - 60_000;
            if (state === 'approved' || (state === 'pending' && asked)) { settle(op.requestKey); return null; }
            return t('ask.notYet');
          }}
          resend={restored ? undefined : { label: t('ask.resend'), busy, onClick: () => { setResendError(null); void ask(op).catch((e: unknown) => setResendError(e instanceof Error ? e.message : String(e))); } }}
          forget={{ label: t('ask.forget'), confirmLabel: t('ask.forgetConfirm'), consequence: t('ask.forgetConsequence'), onForget: () => settle(op.requestKey) }}>
          <Alert tone="warn">{restored ? t('ask.restored') : t('ask.unconfirmed', { error: op.error ?? '' })}</Alert>
        </CheckPanel>
      </>
    );
  }
  return (
    <ConfirmAction label={t('ask.button')} confirmLabel={t('ask.confirm')} consequence={t('ask.consequence')}
      onConfirm={() => ask(startOp(newRequestKey(), { bookingId }))} />
  );
}
