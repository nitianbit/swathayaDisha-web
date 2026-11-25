import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { appointmentAt, appointmentDay, partnerClinicApi, type ClinicAppointmentStatus, type DeskAppointment } from '@jansetu/api';
import { formatClock } from '@jansetu/i18n';
import { Empty, ErrorState, Loading, shared } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/partner/index.ts';
import { useSession } from '../../session.tsx';
import { formatDay } from './labs.tsx';
import { scopeIdentity, useWorkspacePartner, type ScopeContext } from './scope.tsx';

/** WQ6 pages of a partner workspace (members under `/partner`, admins under `/admin/partners/:id`). */
export type ClinicSection = 'clinic-doctors' | 'desk';
export const clinicLink = (ctx: ScopeContext, s: ClinicSection) => (ctx.adminHome ? `${ctx.adminHome}/${s}` : `/partner/${s}`);

/** The clinic routes of this workspace (member, or admin acting as owner). */
export function useClinicApi(ctx: ScopeContext) {
  const { api } = useSession();
  const identity = scopeIdentity(ctx);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => partnerClinicApi(api, ctx.scope), [api, identity]);
}
export type ClinicApi = ReturnType<typeof partnerClinicApi>;

/**
 * `GET /clinic/doctors` (readers: staff.manage, bookings.view, bookings.manage, invoices.create). Same query key as the
 * bill form's doctor picker (`useClinicDoctors`), so one refresh serves both.
 */
export function useDoctorList(ctx: ScopeContext, clinic: ClinicApi) {
  return useQuery({ queryKey: [...ctx.key, 'clinic-doctors'], queryFn: () => clinic.doctors() });
}

/** Doctors and the front desk exist for clinics only (admins may open any partner's URL). */
export function ClinicOnly({ ctx, children }: { ctx: ScopeContext; children: ReactNode }) {
  const partner = useWorkspacePartner(ctx);
  if (partner.isPending) return <Loading label={shared('state.loading')} />;
  if (partner.isError) return <ErrorState message={messageOf(partner.error)} onRetry={() => void partner.refetch()} />;
  if (partner.data?.kind !== 'clinic') {
    const name = partner.data?.name;
    return (
      <Empty title={t('clinic.onlyClinics.title')}>
        {name == null ? t('clinic.onlyClinics.bodyUnnamed') : t('clinic.onlyClinics.body', { name })}
      </Empty>
    );
  }
  return <>{children}</>;
}

/** An instant as India time "HH:MM". */
export const istTime = (iso: string | Date) => {
  const at = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return Number.isNaN(at) ? '—' : formatClock(at);
};

/** An appointment's India-time day and time as staff read them ("Tue, 17 Nov 2026, 10:30"). */
export function appointmentLabel(a: Pick<DeskAppointment, 'bookingDate' | 'bookingTime'>): string {
  const day = appointmentDay(a.bookingDate);
  const at = appointmentAt(a);
  return `${day ? formatDay(day) : a.bookingDate}, ${at ? istTime(at) : a.bookingTime}`;
}

export const appointmentTone = (s: ClinicAppointmentStatus): 'ok' | 'warn' | 'danger' | undefined =>
  s === 'completed' ? 'ok' : s === 'cancelled' || s === 'no_show' ? 'danger' : s === 'pending' ? 'warn' : undefined;
