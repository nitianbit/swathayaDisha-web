/**
 * Customer words of `@jansetu/api` (docs/I18N_PLAN.md §3.2): bills (`customerBills.ts`), lab bookings (`customerLabs.ts`)
 * and medicine stores (`customerPharmacy.ts`). A comment above a key is the translator's note.
 */
export default {
  /** The kind of bill a partner issued. */
  'bill.kind.tax_invoice': 'Tax invoice',
  'bill.kind.bill_of_supply': 'Bill of supply',
  'bill.kind.commercial_invoice': 'Invoice',
  /** How a bill was paid. */
  'bill.payment.cash': 'Cash',
  'bill.payment.upi': 'UPI',
  'bill.payment.card': 'Card',
  'bill.payment.bank': 'Bank transfer',
  'bill.payment.other': 'Other',
  /** Tax lines of a bill (central, state and integrated GST). */
  'bill.tax.cgst': 'CGST',
  'bill.tax.sgst': 'SGST',
  'bill.tax.igst': 'IGST',

  /** Home sample collection address. */
  'lab.address.line1': 'Enter the house number and street (at least 3 characters).',
  'lab.address.under200': 'Keep this under 200 characters.',
  'lab.address.city': 'Enter the city.',
  'lab.address.under80': 'Keep this under 80 characters.',
  'lab.address.under120': 'Keep this under 120 characters.',
  'lab.address.pincode': 'Enter a 6-digit pincode.',
  /** Steps of a lab booking, in order. */
  'lab.step.booked': 'Booked',
  'lab.step.confirmed': 'Paid and confirmed',
  'lab.step.collected': 'Sample collected',
  'lab.step.visited': 'Lab visit done',
  'lab.step.processing': 'Sample being tested',
  'lab.step.reportReady': 'Report ready',
  'lab.step.completed': 'Completed',
  'lab.step.cancelled': 'Cancelled',
  /** The person was not there for the sample or the visit. */
  'lab.step.noShow': 'Marked as not present',

  /** A store's medicine that has no name on record. */
  'store.medicine': 'Medicine',
  /** A prescription upload the server answered without the file. */
  'store.uploadNoFile': 'The upload did not return a file',
} as const;
