import { ACTION_LABEL, actionLabel, targetKindLabel } from './AuditScreen.tsx';

/** Every action the backend records in the partner audit log (stage line a1735c5 and Q16b df87d96, `partners/services/*`). */
const BACKEND_ACTIONS = [
  'partner.profile.update', 'partner.reinstate', 'partner.create', 'partner.update', 'partner.verify', 'partner.suspend', 'member.add', 'member.remove', 'member.permissions', 'member.branches', 'member.email',
  'member.professional', 'branch.create', 'branch.update', 'branch.deactivate', 'branch.reactivate', 'catalogue.create', 'catalogue.update',
  'catalogue.deactivate', 'catalogue.reactivate', 'catalogue.admin_disable', 'catalogue.admin_enable', 'invoice.create', 'invoice.pay',
  'invoice.cancel', 'slots.add', 'slots.capacity', 'slots.close', 'slots.reopen', 'slots.template.save', 'lab_booking.assign',
  'lab_booking.collect', 'lab_booking.visit', 'lab_booking.no_show', 'lab_booking.process', 'lab_booking.complete', 'lab_booking.reject',
  'lab_booking.reschedule', 'lab_booking.no_show_rescheduled', 'lab_booking.report_upload', 'lab_booking.report_remove_draft',
  'lab_booking.report_release', 'clinic.doctor_invited', 'clinic.doctor_invite_revoked', 'clinic.doctor_linked', 'clinic.doctor_unlinked',
  'clinic.doctor_joined', 'clinic.doctor_left', 'clinic.solo_practice_created', 'clinic.appointment_booked', 'clinic.appointment_arrived',
  'clinic.appointment_completed', 'clinic.appointment_no_show', 'clinic.appointment_cancelled', 'clinic.appointment_rescheduled',
  'clinic.appointment_no_show_rescheduled', 'finance.payout_details_changed', 'finance.payout_details_verified', 'finance.payout_recorded',
  'finance.payout_voided', 'finance.adjustment_posted',
];

describe('WQ11b activity log words', () => {
  it('labels every action the backend records', () => {
    expect(BACKEND_ACTIONS.filter((a) => !ACTION_LABEL[a])).toEqual([]);
  });
  it('an action added later reads as words, never as its code', () => {
    expect(actionLabel('invoice.refund')).toBe('Bill: refund');
    expect(actionLabel('lab_booking.report_reopen')).toBe('Lab booking: report reopen');
    expect(actionLabel('newthing.do_it')).toBe('Newthing: do it');
    expect(targetKindLabel('invoice')).toBe('A bill');
    expect(targetKindLabel('some_record')).toBe('Some record');
  });
});
