import Link from 'next/link'
import { cn } from '@/lib/utils'

/** Offers and Clients, side by side at the top of both pages. */
export function OffersTabs({ active }: { active: 'offers' | 'clients' }) {
  const tab = 'inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium'
  return (
    <nav aria-label="Offers sections" className="mb-4 flex gap-2">
      <Link href="/offers" className={cn(tab, active === 'offers' ? 'bg-navy text-white' : 'border border-line text-ink-2 hover:text-ink')}>Offers</Link>
      <Link href="/offers/clients" className={cn(tab, active === 'clients' ? 'bg-navy text-white' : 'border border-line text-ink-2 hover:text-ink')}>Clients</Link>
    </nav>
  )
}
