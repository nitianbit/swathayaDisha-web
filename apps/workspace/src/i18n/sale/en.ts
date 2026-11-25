/**
 * WQ50: the pharmacy's counter sale (Pharmacy › New sale): the customer, medicines from stock, an optional prescription,
 * the sale, its bill and the counter payment (docs/I18N_PLAN.md §3.3). A comment above a key is the translator's note.
 * Amounts arrive formatted ("₹1,000.00"); names, phones and medicine names are values, never words.
 */
export default {
  'title': 'New sale',
  'intro': 'Sell medicines at your counter: choose the customer, add medicines from your stock, then take the payment.',
  'create': 'Next: check the sale',

  'customer.title': 'Customer',
  /** A customer already linked to this pharmacy. */
  'customer.existing': 'A customer of your pharmacy',
  /** Someone at the counter who is not a customer of this pharmacy yet. */
  'customer.walkIn': 'Walk-in customer',
  'customer.required': 'Choose the customer, or enter the walk-in customer’s name and phone.',
  'customer.search': 'Search by name or phone',
  'customer.searchHint': 'Leave it empty to see your latest customers.',
  'customer.results': 'Customers found',
  'customer.none': 'No customer found',
  'customer.noneText': 'Try another name or phone, or choose “Walk-in customer”.',
  /** {customer}: name and phone. */
  'customer.choose': 'Choose {customer}',
  'customer.chosen': 'Customer: {customer}.',
  /** A customer whose name this pharmacy may not show. */
  'customer.unnamed': 'Customer',

  'walkIn.name': 'Customer’s name',
  'walkIn.phone': 'Mobile number (10 digits)',
  /** WQ50b: what the agreement covers: the pharmacy's customers, and a Jansetu account for that phone when there is none. */
  'walkIn.consent': 'The customer agreed to be added to your pharmacy’s customers, and to a Jansetu account being made for this phone if they have none',
  'walkIn.nameError': 'Enter the customer’s name (at most {max} characters).',
  'walkIn.phoneError': 'Enter a 10-digit mobile number.',
  'walkIn.consentError': 'Ask the customer first; tick this only when they agree.',
  /** {error}: why the answer was not read. Adding the same customer again is safe. */
  'walkIn.notConfirmed': 'The customer could not be added ({error}). Nothing was sold. Try again: the same customer is never added twice.',

  'lines.title': 'Medicines',
  'lines.search': 'Find a medicine in your stock',
  'lines.results': 'Medicines in stock',
  'lines.none': 'Nothing to sell found',
  'lines.noneText': 'Only active stock that has not expired can be sold. Try another name.',
  'lines.caption': 'Medicines in this sale',
  'lines.medicine': 'Medicine',
  'lines.qty': 'Quantity',
  'lines.price': 'Price each',
  'lines.remove': 'Remove',
  /** {medicine}: the medicine's name. */
  'lines.add': 'Add {medicine}',
  'lines.removeOf': 'Remove {medicine}',
  'lines.qtyOf': 'Quantity of {medicine}',
  'lines.inStock': '{count} in stock',
  'lines.noPrice': 'No price set',
  'lines.required': 'Add at least one medicine.',
  'lines.qtyError': 'Each quantity must be a whole number from 1 to what is in stock.',

  'prescription.title': 'Prescription (optional)',
  'prescription.intro': 'Attach the customer’s prescription for prescription medicines. Your pharmacist checks the sale before it is paid.',
  'prescription.add': 'Attach a prescription (photo or PDF)',
  'prescription.uploading': 'Attaching the prescription…',
  /** {n}: 1, 2, … */
  'prescription.attached': 'Prescription {n} attached.',
  'prescription.remove': 'Remove prescription {n}',
  'prescription.noFile': 'The prescription was not attached. Try again.',
  'prescription.failed': 'The prescription was not attached: {error}',

  'total.title': 'Total',
  'total.estimate': 'About {amount}',
  'total.taxNote': 'From your selling prices. Prices include tax. The bill shows the final amount.',
  /** WQ50b: the server then uses the stock's wholesale price, if it has one. */
  'total.unpriced': 'A medicine has no selling price set: the sale uses its wholesale price, or is refused when there is none. Set the selling price in Stock.',

  'review.title': 'Check the sale',
  /** {count}: how many different medicines. */
  'review.text': {
    one: 'Sell {count} medicine to {customer}, about {amount}? It is taken from your stock now.',
    other: 'Sell {count} medicines to {customer}, about {amount}? They are taken from your stock now.',
  },
  'review.walkIn': 'The walk-in customer is added to your pharmacy’s customers first (and gets a Jansetu account for this phone if they have none).',
  'review.create': 'Create sale',

  'unconfirmed.panel': 'Unconfirmed sale',
  /** {error}: why the answer was not read. */
  'unconfirmed.text': 'The outcome of this sale is not known yet ({error}). It may already be recorded, so it is not sent again. Check whether it was recorded.',
  'unconfirmed.restored': 'A sale started on this device earlier was not confirmed. Its details are not kept here. Look for it in Orders before selling again.',
  'unconfirmed.lookInOrders': 'Look for it in Orders (newest first). Forget it here only once you know.',
  /** In place of the reason when none was given. */
  'unconfirmed.noAnswer': 'no answer came back',
  'unconfirmed.notFound': 'Not recorded so far. It may still be on its way: check again in a moment.',
  'unconfirmed.several': 'Several sales like this one were found. Look in Orders.',
  'unconfirmed.forget': 'Forget it',
  'unconfirmed.forgetConfirm': 'Yes, forget it',
  'unconfirmed.forgetConsequence': 'If it was recorded after all, it appears in Orders; cancel it there if it is not wanted.',

  'refusal.INSUFFICIENT_BATCH_STOCK': 'Not enough of a medicine is in stock now. Search it again and lower the quantity.',
  'refusal.INSUFFICIENT_STOCK': 'Not enough of a medicine is in stock now. Search it again and lower the quantity.',
  'refusal.MEDICINE_NOT_AVAILABLE': 'A medicine is no longer sold. Remove it and try again.',
  'refusal.PRICE_NOT_AVAILABLE': 'A medicine has no selling price yet. Set it in Stock, then try again.',
  'refusal.DUPLICATE_ORDER_MEDICINE': 'A medicine is in the sale twice. Keep it once with the full quantity.',
  'refusal.CUSTOMER_NOT_LINKED': 'This customer is not one of your pharmacy’s customers. Add them as a walk-in customer.',
  'refusal.USER_NOT_FOUND': 'This customer’s account was not found. Add them as a walk-in customer.',
  'refusal.CONSENT_REQUIRED': 'The customer must agree before being added to your pharmacy.',
  'refusal.FORBIDDEN': 'Your pharmacy cannot sell through Jansetu right now. Please contact Jansetu support.',
  'refusal.PRESCRIPTION_CHECKOUT_UNAVAILABLE': 'Sales with prescriptions are not available right now. Try again later.',
  'refusal.PRESCRIPTION_REVIEW_REQUIRED': 'Your pharmacist must approve the prescription before this sale is paid.',
  'refusal.MARK_PAID_NOT_ALLOWED': 'This sale cannot be marked paid at the counter.',
  'refusal.ORDER_TERMINAL': 'This sale is closed, so it cannot be marked paid.',
  'refusal.ORDER_CANCEL_PENDING': 'A cancellation of this sale waits for a decision. Decide it in Orders first.',
  'refusal.ORDER_ALREADY_REFUNDED': 'This sale was refunded, so it cannot be marked paid.',

  'done.intro': 'The bill of this sale, and its payment at the counter.',
  'done.loading': 'Loading the sale…',
  'done.notFound': 'Sale not found',
  /** WQ50b: from the prescription review back to the sale it was opened from. */
  'done.backToSale': 'Back to the sale',
  'done.print': 'Print the bill',
  'done.openOrder': 'Open the order',
  'done.new': 'Start a new sale',

  /** {order}: the order number. */
  'bill.title': 'Bill {order}',
  /** {gstin}: the pharmacy's GST number. */
  'bill.gstin': 'GSTIN {gstin}',
  'bill.walkIn': 'Walk-in customer',
  'bill.batch': 'Batch and expiry',
  /** {batch}: batch number; {expiry}: its expiry date. */
  'bill.batchLine': '{batch}, expires {expiry}',
  'bill.caption': 'The bill’s medicines',
  'bill.unit': 'Price each',
  'bill.amount': 'Amount',
  /** A prescription medicine. */
  'bill.rx': 'Prescription',
  'bill.discount': 'Discount',
  'bill.total': 'Total',
  /** Prices include GST; this line says how much of the total it is. */
  'bill.gstIncluded': 'GST',
  'bill.ofWhichGst': 'of which GST {amount}',
  'bill.payment': 'Payment',
  'bill.paid': 'Paid',
  /** {how}: Cash or UPI. */
  'bill.paidBy': 'Paid by {how}',
  'bill.unpaid': 'Not paid yet',

  'payment.title': 'Payment at the counter',
  'payment.how': 'Paid by',
  'payment.cash': 'Cash',
  'payment.upi': 'UPI',
  'payment.markPaid': 'Mark paid',
  'payment.confirm': 'Yes, it is paid',
  /** {how}: Cash or UPI. */
  'payment.consequence': 'Record {amount} received at the counter by {how}? The sale shows as paid.',
  'payment.waitsForPharmacist': 'This sale has a prescription medicine: your pharmacist approves the prescription before it is paid.',
  'payment.review': 'Review the prescription',
  'payment.rejected': 'The pharmacist rejected the prescription, so this sale cannot be paid. Cancel it in Orders.',
  'payment.notConfirmed': 'Not confirmed ({error}). The sale was read again; marking it paid again is safe.',
} as const;
