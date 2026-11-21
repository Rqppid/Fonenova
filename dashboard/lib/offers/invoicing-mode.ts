/**
 * Who makes the client invoices. For now Invoice2go does (its Bcc goes to Make, which creates the Xero invoice); the
 * dashboard only does offers, acceptance and the reply to Mobile One. The dashboard's own invoice code stays in place,
 * switched off, until the owner approves a cutover: set OFFERS_INVOICING=dashboard then.
 *
 * Safe by default: anything but exactly "dashboard" (including the variable missing) means Invoice2go.
 * Pure, so the screen and the server read it the same way.
 */
export type InvoicingMode = 'invoice2go' | 'dashboard'

export const invoicingModeFrom = (v: string | undefined): InvoicingMode => (v?.trim().toLowerCase() === 'dashboard' ? 'dashboard' : 'invoice2go')

/** The setting for the running server. */
export const invoicingModeFromEnv = (): InvoicingMode => invoicingModeFrom(process.env.OFFERS_INVOICING)

/** `invoicing` is set by the one production builder of the deps; directly built deps (the dormant path's tests) mean on. */
export const invoicingOn = (d: { invoicing?: boolean }): boolean => d.invoicing !== false

export const INVOICE2GO_NOTE = 'Invoices are made in Invoice2go for now. Create and send the invoice there once the goods have arrived and the DHL cost is known.'
