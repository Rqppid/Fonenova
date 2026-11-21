/** Which side of the books a payments exception is on (pure, shared by the page and the summary). */
export const exceptionActionsSide = (code: string): 'supplier' | 'customer' => (code.startsWith('X-OUT') ? 'supplier' : 'customer')

/** Exceptions that are about something other than a payment still waiting for an invoice (or are already applied): never shown as an unmatched payment. */
const NOT_A_WAITING_PAYMENT = ['X-REVERSAL', 'X-TOKEN', 'X-FETCH', 'X-BULK', 'X-OVERPAY']
export const isWaitingPayment = (code: string): boolean => !NOT_A_WAITING_PAYMENT.includes(code) && !code.startsWith('X-XERO-')
