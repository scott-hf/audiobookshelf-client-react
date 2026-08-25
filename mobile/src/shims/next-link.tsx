import type { ComponentProps } from 'react'
import { Link as RouterLink } from 'react-router-dom'

type NextLinkProps = Omit<ComponentProps<'a'>, 'href'> & {
  href: string
  replace?: boolean
  prefetch?: boolean
  scroll?: boolean
}

/**
 * `next/link` stand-in, aliased in vite/vitest/tsconfig.
 *
 * Ported upstream components import `next/link`; the mobile shell routes with
 * react-router. Aliasing here (rather than editing each ported file) keeps those
 * files byte-identical to upstream so they stay diffable when pulling changes.
 *
 * Absolute/external hrefs fall through to a plain <a> -- react-router's Link would
 * try to treat them as in-app paths.
 */
export default function Link({ href, replace, prefetch: _prefetch, scroll: _scroll, children, ...props }: NextLinkProps) {
  const isExternal = /^([a-z][a-z0-9+.-]*:)?\/\//i.test(href) || href.startsWith('mailto:') || href.startsWith('tel:')

  if (isExternal) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    )
  }

  return (
    <RouterLink to={href} replace={replace} {...props}>
      {children}
    </RouterLink>
  )
}
