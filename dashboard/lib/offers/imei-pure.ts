/** Pure helpers the IMEI screen uses. No server imports, so the browser bundle can include it. */
import type { ImeiFile } from './types'

/** The files to show first: the IMEI lists. Everything else (a label, an invoice) waits behind "Show other files". */
export const splitCandidates = <T extends { kind: ImeiFile['kind'] }>(all: readonly T[]) => ({ imei: all.filter((c) => c.kind === 'imei'), other: all.filter((c) => c.kind !== 'imei') })
