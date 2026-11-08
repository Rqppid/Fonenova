export default function Loading() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-10 sm:px-6 lg:pl-[264px]" role="status">
      <div className="h-6 w-40 animate-pulse rounded bg-black/[0.06]" />
      <div className="mt-6 h-20 animate-pulse rounded-lg bg-black/[0.04]" />
      <div className="mt-4 h-64 animate-pulse rounded-lg bg-black/[0.04]" />
      <span className="sr-only">Loading payments…</span>
    </div>
  )
}
