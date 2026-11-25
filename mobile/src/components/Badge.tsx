import { mergeClasses } from '@/lib/merge-classes'

/**
 * `success-solid` is for a badge laid OVER artwork (a book cover). The other tones are 20% tints
 * of the status colour, which only read against a flat app surface: over an arbitrary cover a tint
 * has no guaranteed contrast. This one is opaque with dark text (about 6.8:1, `bg-success` against
 * `text-black-600`, WCAG AA) so the text's contrast is its own backing's and does not depend on
 * the picture underneath. The `ring` keeps the chip's edge visible over a cover that happens to be
 * the same green.
 */
type BadgeTone = 'neutral' | 'success' | 'success-solid' | 'error' | 'info' | 'warning'

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-black-300 text-foreground-muted',
  success: 'bg-success/20 text-success',
  'success-solid': 'bg-success text-black-600 ring-1 ring-black-600',
  error: 'bg-error/20 text-error',
  info: 'bg-info/20 text-info',
  warning: 'bg-warning/20 text-warning'
}

interface BadgeProps {
  children: React.ReactNode
  tone?: BadgeTone
  className?: string
}

/**
 * Small read-only status chip.
 *
 * Upstream's `Pill` is an editable/removable tag (inline editing, remove button) and is the
 * wrong contract for status labels, so this is a mobile-local component built on the same
 * design tokens rather than a port.
 */
export default function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return <span className={mergeClasses('inline-flex items-center rounded px-1.5 py-0.5 text-xxs font-semibold whitespace-nowrap', TONE_CLASSES[tone], className)}>{children}</span>
}
