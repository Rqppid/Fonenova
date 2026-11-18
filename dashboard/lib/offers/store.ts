/** Reads and saves the offers and the clients (server side). */
import { getJson, getStore } from '../store'
import { clientsFrom, type Client } from './clients'
import type { Offer } from './types'

/** The saved clients, or the first-run list until the owner saves one. */
export async function loadClients(): Promise<Client[]> {
  return clientsFrom(await getJson<Client[]>(getStore(), 'offers:clients'))
}

export async function loadOffers(): Promise<Offer[]> {
  return (await getJson<Offer[]>(getStore(), 'offers')) ?? []
}
