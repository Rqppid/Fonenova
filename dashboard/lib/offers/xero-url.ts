/** Where a draft invoice is opened in Xero. No imports, so screens (client components) can use it. */
export const xeroDraftUrl = (id: string) => `https://go.xero.com/app/invoicing/view/${encodeURIComponent(id)}`
