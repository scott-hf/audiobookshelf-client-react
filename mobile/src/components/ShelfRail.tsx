import { useId, type ReactNode } from 'react'

interface ShelfRailProps {
  /** Server-supplied shelf label, shown as-is. */
  label: string
  children: ReactNode
}

/**
 * One horizontally scrolling home shelf: a heading over a swipeable row of fixed-width cards.
 *
 * The row bleeds to the screen edges (`-mx-4 px-4` cancels the page's `px-4`) so cards scroll
 * under the edge instead of being clipped at the content margin, and `overscroll-x-contain` stops
 * a sideways swipe at the end of the rail from also triggering the shell's back gesture.
 */
export default function ShelfRail({ label, children }: ShelfRailProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="mb-6">
      <h2 id={headingId} className="text-foreground mb-2 text-base font-semibold">
        {label}
      </h2>
      <ul className="-mx-4 flex snap-x snap-proximity gap-3 overflow-x-auto overscroll-x-contain px-4 pb-2">{children}</ul>
    </section>
  )
}

/** One fixed-width slot in a [ShelfRail]; width is set here so every rail's cards line up. */
export function ShelfRailItem({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={`w-28 shrink-0 snap-start ${className ?? ''}`.trim()}>{children}</li>
}
