import { NavLink } from 'react-router-dom'
import { mergeClasses } from '@/lib/merge-classes'

interface Tab {
  to: string
  icon: string
  label: string
}

const TABS: Tab[] = [
  { to: '/libraries', icon: 'library_books', label: 'Library' },
  { to: '/downloads', icon: 'download_for_offline', label: 'Downloads' },
  { to: '/settings', icon: 'settings', label: 'Settings' }
]

/**
 * Bottom tab bar for the native shell.
 *
 * Upstream is a desktop-first web client with a persistent side/top nav; a thumb-reachable
 * bottom bar is the mobile idiom, so this is intentionally a mobile-only component. It uses
 * upstream's design tokens (bg-primary, nav-item-selected, Material Symbols) so it reads as
 * the same product.
 */
export default function AppTabBar() {
  return (
    <nav
      className="bg-primary border-border box-shadow-md-up z-20 flex shrink-0 border-t"
      style={{ paddingBottom: 'var(--abs-safe-bottom)' }}
      aria-label="Primary"
    >
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            mergeClasses(
              'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xxs font-medium transition-colors',
              isActive ? 'text-accent bg-nav-item-selected' : 'text-foreground-subdued'
            )
          }
        >
          {({ isActive }) => (
            <>
              <span className={mergeClasses('material-symbols text-2xl', isActive && 'fill')} aria-hidden="true">
                {tab.icon}
              </span>
              <span>{tab.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
