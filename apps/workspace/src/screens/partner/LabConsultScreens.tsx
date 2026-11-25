import { Fragment, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  holdsAny, LAB_CONSENT_STATEMENT, LAB_CONSENT_STATEMENT_VERSION, LAB_PAYER, labAssistedApi, labBookerRefusal, labWalletApi,
} from '@jansetu/api';
import { ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { BookConsultation } from '../pharmacy/BookConsultationScreen.tsx';
import { BookedConsultationDetail } from '../pharmacy/BookedConsultationScreen.tsx';
import { BookedConsultationsList } from '../pharmacy/BookedConsultationsScreen.tsx';
import type { ConsultBooker } from '../pharmacy/consultBooker.ts';
import { ownerTopupSource } from '../pharmacy/topup.tsx';
import { LabOnly, useScopedBranches } from './labs.tsx';
import { NoSuchPartner, PartnerPageHeading, scopeIdentity, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

/**
 * WQ24: a lab member holding `assisted.book` books a doctor consultation for a walk-in patient (assisted booking round 2e,
 * backend r21, design ASSISTED_BOOKING_DESIGN.md §24.17). These are the pharmacy's own screens (Book consultation, Booked
 * consultations) with the lab's `ConsultBooker`: the routes under `/partner-workspace/assisted/*` with the member's branch,
 * the lab wallet (WQ20) or card or UPI (verified on the lab's own payment routes), the lab's consent words. The lab reads
 * the prescription's dispensing copy for 90 days; refunds go back the way it was paid. The lab's own members only (the
 * lab wallet and payment routes have no admin mirror).
 */
const BOOK = '/partner/book-consultation';
const LIST = '/partner/consultations';

/** The lab's booker: its routes, keys, wallet (read with `wallet.view`, topped up with `wallet.manage`), branches in scope. */
function useLabBooker(ctx: ScopeContext) {
  const { api } = useSession();
  const branches = useScopedBranches(ctx);
  const id = scopeIdentity(ctx);
  const w = labWalletApi(api, ctx.scope);
  const walletKey = [...ctx.key, 'lab-wallet'];
  const canView = holdsAny(ctx.actor, ['wallet.view']);
  const canAdd = holdsAny(ctx.actor, ['wallet.manage']);
  const booker: ConsultBooker = {
    kind: 'lab', id, api: labAssistedApi(api), refusal: labBookerRefusal,
    bookingsKey: [...ctx.key, 'assisted-bookings'], doctorsKey: [...ctx.key, 'assisted-doctors'],
    wallet: {
      owner: 'lab', queryKey: walletKey, read: canView ? () => w.wallet() : null, topup: canAdd ? ownerTopupSource(w, 'lab', id, walletKey) : null,
      page: canView || canAdd ? '/partner/wallet' : null,
    },
    payer: LAB_PAYER,
    consent: { statement: LAB_CONSENT_STATEMENT, version: LAB_CONSENT_STATEMENT_VERSION },
    paths: { book: BOOK, list: LIST },
    branches: branches.inScope.map((b) => ({ id: b._id, name: b.name })),
  };
  return { booker, branches };
}

/** The lab's own members only (`/partner/...`); one subtree per lab, so nothing half-made carries over to another. */
function MemberOnly({ children }: { children: (ctx: ScopeContext) => ReactNode }) {
  const ctx = usePartnerScope();
  if (!ctx || ctx.scope.kind !== 'member') return <NoSuchPartner />;
  return <Fragment key={scopeIdentity(ctx)}>{children(ctx)}</Fragment>;
}

export function LabBookConsultationScreen() {
  return <MemberOnly>{(ctx) => <LabBook ctx={ctx} />}</MemberOnly>;
}

function LabBook({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Book consultation" partnerName={partner.data?.name}>
        Book a doctor for a patient at your lab. You pay Jansetu from the lab’s wallet, or by card or UPI; you collect the fee from the patient.
      </PartnerPageHeading>
      <LabOnly ctx={ctx}><LabBookFlow ctx={ctx} /></LabOnly>
    </>
  );
}

function LabBookFlow({ ctx }: { ctx: ScopeContext }) {
  const { booker, branches } = useLabBooker(ctx);
  // The branch is chosen from the member's branches, so they are read first.
  if (branches.isPending) return <Loading label="Loading your branches…" />;
  if (branches.isError) return <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />;
  return <BookConsultation booker={booker} />;
}

export function LabBookedConsultationsScreen() {
  return <MemberOnly>{(ctx) => <LabBooked ctx={ctx} />}</MemberOnly>;
}

function LabBooked({ ctx }: { ctx: ScopeContext }) {
  const partner = useWorkspacePartner(ctx);
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Booked consultations" partnerName={partner.data?.name}>
        Consultations your lab booked for patients, newest first. Open one to cancel it, join the call or see the prescription.
        {' '}<Link to={BOOK}>Book a new one</Link>.
      </PartnerPageHeading>
      <LabOnly ctx={ctx}><LabBookedList ctx={ctx} /></LabOnly>
    </>
  );
}

function LabBookedList({ ctx }: { ctx: ScopeContext }) {
  return <BookedConsultationsList booker={useLabBooker(ctx).booker} />;
}

export function LabBookedConsultationScreen() {
  const { bookingId = '' } = useParams();
  return (
    <MemberOnly>
      {(ctx) => (
        <>
          <Link to={LIST} className="ws-back"><ArrowLeft size={16} aria-hidden="true" /> Booked consultations</Link>
          <PageHeading title="Consultation" />
          <LabOnly ctx={ctx}><LabDetail key={bookingId} ctx={ctx} bookingId={bookingId} /></LabOnly>
        </>
      )}
    </MemberOnly>
  );
}

function LabDetail({ ctx, bookingId }: { ctx: ScopeContext; bookingId: string }) {
  return <BookedConsultationDetail booker={useLabBooker(ctx).booker} bookingId={bookingId} />;
}
