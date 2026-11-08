'use client'
import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { AlertTriangle, Building2, Calculator, Landmark, FileMinus2, LayoutDashboard, Link2, LogOut, Menu, Package, Receipt, Settings, Users } from 'lucide-react'
import { BrandMark, BrandName } from '@/components/brand'
import { Sheet } from '@/components/ui/sheet'
import { useSection, type Section } from '@/lib/sections'
import { cn } from '@/lib/utils'

/** A section of the main page (#id), or a page of its own (route). */
type Item = { id: Section; label: string; icon: typeof LayoutDashboard; route?: never } | { route: string; label: string; icon: typeof LayoutDashboard; id?: never }

const GROUPS: { title: string | null; items: Item[] }[] = [
  { title: null, items: [{ id: 'overview', label: 'Overview', icon: LayoutDashboard }] },
  { title: 'Sales', items: [
    { id: 'orders', label: 'Orders', icon: Package },
    { id: 'deal-check', label: 'Check a deal', icon: Calculator },
    { id: 'matching', label: 'Invoice matching', icon: Link2 },
    { route: '/payments', label: 'Payments', icon: Landmark },
    { id: 'customers', label: 'Customers', icon: Users },
    { id: 'credit-notes', label: 'Credit notes', icon: FileMinus2 },
  ] },
  { title: 'Costs', items: [
    { id: 'suppliers', label: 'Suppliers', icon: Building2 },
    { id: 'expenses', label: 'Expenses', icon: Receipt },
  ] },
  { title: 'Admin', items: [
    { id: 'exceptions', label: 'Exceptions', icon: AlertTriangle },
    { id: 'settings', label: 'Settings', icon: Settings },
  ] },
]

/** Work waiting on a page, shown as a small count beside it. */
export type NavBadges = Partial<Record<Section, { count: number; title: string; tone: 'loss' | 'warn' }>>

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark className="h-7 w-7" />
      <div className="leading-tight">
        <BrandName dark className="block text-[15px]" />
        <div className="text-[11px] text-navy-ink/70">Fone Nova Ltd</div>
      </div>
    </div>
  )
}

function Nav({ onPick, badges }: { onPick?: () => void; badges?: NavBadges }) {
  const [section, go] = useSection()
  const path = usePathname()
  const onMain = path === '/'
  return (
    <nav aria-label="Main" className="mt-6 space-y-4">
      {GROUPS.map((g) => (
        <div key={g.title ?? 'top'}>
          {g.title && <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-navy-ink/45">{g.title}</div>}
          <div className="space-y-0.5">
            {g.items.map((item) => {
              const { label, icon: Icon } = item
              const active = item.route ? path === item.route : onMain && item.id === section
              const b = item.id ? badges?.[item.id] : undefined
              // Sections live on the main page: from another page they are ordinary links to /#id.
              const href = item.route ?? (onMain ? (item.id === 'overview' ? '#' : `#${item.id}`) : item.id === 'overview' ? '/' : `/#${item.id}`)
              return (
                <a
                  key={item.route ?? item.id}
                  href={href}
                  onClick={(e) => {
                    if (item.id && onMain) { e.preventDefault(); go(item.id) }
                    onPick?.()
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={cn('flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13.5px]', active ? 'bg-white/[0.09] font-medium text-white' : 'text-navy-ink/85 hover:bg-white/[0.05] hover:text-white')}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  <span className="flex-1">{label}</span>
                  {b && b.count > 0 && (
                    <span title={b.title} className={cn('min-w-5 rounded-full px-1.5 py-px text-center text-[11px] font-semibold', b.tone === 'loss' ? 'bg-loss text-white' : 'bg-warn-soft text-warn')}>
                      {b.count}<span className="sr-only"> {b.title}</span>
                    </span>
                  )}
                </a>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}

function Account({ email }: { email: string | null }) {
  if (!email) return null
  return (
    <form action="/auth/logout" method="post" className="mb-4 border-b border-white/10 pb-4">
      <div className="truncate text-[12px] text-navy-ink/80" title={email}>{email}</div>
      <button type="submit" className="mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-white/90 hover:text-white">
        <LogOut className="h-3.5 w-3.5" aria-hidden />Sign out
      </button>
    </form>
  )
}

export function Shell({ children, footer, email = null, badges }: { children: React.ReactNode; footer?: React.ReactNode; email?: string | null; badges?: NavBadges }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-h-dvh lg:pl-[232px]">
      <aside className="fixed inset-y-0 left-0 hidden w-[232px] flex-col bg-navy px-4 py-5 lg:flex">
        <Wordmark />
        <Nav badges={badges} />
        <div className="mt-auto">
          <Account email={email} />
          <div className="text-[11.5px] leading-relaxed text-navy-ink/60">{footer}</div>
        </div>
      </aside>
      <div className="sticky top-0 z-30 flex h-12 items-center justify-between bg-navy px-4 lg:hidden">
        <Wordmark />
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-white hover:bg-white/10"
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>
      <Sheet open={open} onOpenChange={setOpen} side="left" title="Navigation" className={cn('max-w-[280px] bg-navy [&>div:first-child]:bg-navy [&>div:first-child]:border-white/10 [&_h2]:text-white')}>
        <div className="px-4 pb-6">
          <Nav badges={badges} onPick={() => setOpen(false)} />
          <div className="mt-6">
            <Account email={email} />
            <div className="text-[11.5px] leading-relaxed text-navy-ink/60">{footer}</div>
          </div>
        </div>
      </Sheet>
      <main className="mx-auto max-w-[1400px] px-4 pb-16 sm:px-6 lg:px-8">{children}</main>
    </div>
  )
}
