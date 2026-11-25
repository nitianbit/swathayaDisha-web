/**
 * Pharmacy words of `@jansetu/api` (docs/I18N_PLAN.md §3.2): order and payment states (`pharmacyOrders.ts`), suppliers
 * (`pharmacySuppliers.ts`), adding stock and stock-file imports (`pharmacyStock.ts`). A comment above a key is the
 * translator's note. Column names of the stock file ("medicine name", "mrp" …) are not here: the importer reads them.
 */
export default {
  /** A medicine order's state. */
  'order.status.placed': 'Placed',
  'order.status.accepted': 'Accepted',
  'order.status.packed': 'Packed',
  'order.status.ready_for_pickup': 'Ready for pickup',
  'order.status.out_for_delivery': 'Out for delivery',
  'order.status.delivery_failed': 'Delivery failed',
  'order.status.completed': 'Completed',
  /** The customer never paid or collected it. */
  'order.status.abandoned': 'Abandoned',
  'order.status.cancelled': 'Cancelled',
  'order.status.rejected': 'Rejected',
  'order.status.pending_cancel': 'Cancellation requested',
  /** An order's payment state. */
  'payment.status.pending': 'Unpaid',
  /** The money is held on the card, not yet taken. */
  'payment.status.authorized': 'Authorised',
  'payment.status.paid': 'Paid',
  'payment.status.failed': 'Payment failed',
  'payment.status.refunded': 'Refunded',
  'payment.status.partially_paid': 'Partly paid',

  /** Supplier form field names. */
  'supplier.field.displayName': 'Supplier name',
  'supplier.field.contactName': 'Contact person',
  'supplier.field.phone': 'Phone',
  'supplier.field.email': 'Email',
  'supplier.field.address': 'Address',
  'supplier.nameRequired': 'Enter the supplier’s name.',
  'supplier.phone': 'Use digits, spaces and + ( ) . - only.',
  'supplier.email': 'Enter an email such as orders@distributor.in.',
  /** Under a field that is too long. */
  'field.atMost': 'At most {max} characters.',

  /** Why stock is added by hand. */
  'stock.reason.purchase': 'New purchase',
  'stock.reason.return': 'Returned stock put back',
  'stock.reason.transfer': 'Transfer from another shop',
  'stock.reason.correction': 'Stock count correction',
  'stock.reason.other': 'Other',
  /** The supplier chosen for a delivery. */
  'stock.supplierRefusal.SUPPLIER_NOT_FOUND': 'That supplier is not one of yours any more. Choose another supplier, or none.',
  'stock.supplierRefusal.SUPPLIER_ARCHIVED': 'That supplier has been archived. Choose an active supplier, or none.',
  'stock.medicine': 'Choose the medicine.',
  'stock.batch': 'Enter the batch number printed on the pack.',
  'stock.expiry': 'Enter the expiry date.',
  'stock.expired': 'This batch has expired. Expired stock cannot be added.',
  'stock.quantity': 'Enter the number of units, at least 1.',
  'stock.rupees': 'Enter an amount in rupees, e.g. 42.50.',
  /** The stock level at which the medicine shows as low. */
  'stock.reorder': 'Enter a whole number of units.',
  'stock.reasonRequired': 'Choose why the stock is added.',
  'stock.supplierAgain': 'Choose the supplier again.',

  /** A stock-file import's state. */
  'import.status.pending': 'Uploading',
  'import.status.previewed': 'Checked, not added yet',
  'import.status.committing': 'Being added',
  'import.status.committed': 'Added',
  'import.status.partially_committed': 'Partly added',
  'import.status.failed': 'Not added',
  /** One row of a stock file. */
  'import.row.valid': 'Ready',
  'import.row.error': 'Problem',
  'import.row.skipped': 'Skipped',
  'import.row.committed': 'Added',
  'import.row.failed': 'Failed',
  /** How an import treats medicines already in stock. */
  'import.mode.upsert': 'Add every row',
  'import.mode.upsertHint': 'Medicines already in your stock get the new batch; others are added.',
  'import.mode.updateOnly': 'Only medicines already in my stock',
  'import.mode.updateOnlyHint': 'Rows for other medicines are skipped.',
  'import.mode.createOnly': 'Only medicines not yet in my stock',
  'import.mode.createOnlyHint': 'Rows for medicines you already stock are skipped.',
  /** Whether a column of the stock file must be filled. */
  'import.need.required': 'Required',
  'import.need.toAddUnits': 'Required to add units',
  'import.need.whenAdding': 'When adding units',
  'import.need.keepsPrice': 'Optional — blank keeps the current price',
  'import.need.optional': 'Optional',
  /** How to fill each column of the stock file ("medicine name", "quantity to add", …). */
  'import.format.medicineName': 'As in the medicine list. A name not in the list adds a new medicine. A row whose name starts with # is a note and is not imported.',
  'import.format.quantity': 'Whole number from 0 to 1,000,000 (1,000 is fine). 0 only updates prices and rack.',
  'import.format.batch': 'As printed on the pack.',
  'import.format.expiry': 'Day first, e.g. 31-12-2027 (see below). Not in the past, at most 15 years ahead.',
  'import.format.mrp': 'Rupees, e.g. 42.50 or 1,250.00. Use a point for paise: 1,5 is refused. 0 sets the price to ₹0.',
  'import.format.retail': 'Your selling price in rupees. A new medicine without one is not on sale until you price it.',
  'import.format.rupees': 'Rupees.',
  'import.format.gst': '0 to 100, written 18 or 18%. Used only for a new medicine.',
  'import.format.newOnly': 'Used only for a new medicine.',
  'import.format.prescription': 'For a new medicine: “no” if it is sold without a prescription. Left blank, a new medicine needs a prescription.',
  /** A shelf place such as B2. */
  'import.format.rack': 'e.g. B2.',
  'import.format.active': '“no” to keep a new medicine inactive.',
  'import.format.supplier': 'One of your suppliers, by name as on your supplier list. Recorded for rows that add units. Or choose one supplier for the whole file below.',
  /** Ways of writing an expiry date that the import reads (YYYY, MM and DD stay as written). */
  'import.expiry.ymd': 'YYYYMMDD, for example 20271231 (as text or a number)',
  'import.expiry.isoDate': 'YYYY-MM-DD, for example 2027-12-31',
  'import.expiry.dayFirst': 'DD-MM-YYYY or DD/MM/YYYY, day first, for example 31-12-2027 or 31/12/2027',
  'import.expiry.monthYear': 'MM/YYYY or MM-YYYY, as printed on packs, for example 12/2027: the last day of that month',
  'import.expiry.excel': 'a date cell in Excel',
  'import.numberNote': 'Numbers may use commas between thousands, such as 1,000 or 10,00,000. Write paise with a point (12.50): a price such as 1,5 or 12 rs is refused on its row.',
  /** The one date form that is always read right. */
  'import.dateFormat': 'DD-MM-YYYY (day first), for example 31-12-2027',
  'import.file.choose': 'Choose the file to import.',
  'import.file.type': 'Use an Excel (.xlsx, .xls) or CSV (.csv) file.',
  'import.file.empty': 'This file is empty.',
  'import.file.tooLarge': 'The file is larger than 10 MB. Split it into smaller files.',
  /** Why the server refused an uploaded stock file. */
  'import.refusal.UNEXPECTED_FILE_FIELD': 'Upload one file at a time.',
  'import.refusal.UPLOAD_INVALID': 'The upload did not arrive whole. Choose the file and check it again.',
  'import.refusal.PARSE_FAILED': 'The file could not be read. Save it again as .xlsx or .csv and upload it again.',
  'import.refusal.IMPORT_FILE_EMPTY': 'The first sheet of the file has no rows. Fill in the template and upload it again.',
  'import.refusal.IMPORT_COLUMNS_MISSING': 'The first row has no “medicine name” column. Keep the column names of the template in the first row.',
  'import.refusal.IMPORT_FILE_TOO_BIG': 'The file is too big to import at once (at most 200,000 cells). Split it into smaller files and import them one after another.',
  /** Prices a stock-file row sets, named in a sentence ("sets the MRP and selling price to ₹0"). */
  'import.price.mrp': 'MRP',
  'import.price.retailPrice': 'selling price',
  'import.price.purchasePrice': 'purchase price',
  'import.price.wholesalePrice': 'wholesale price',
} as const;
