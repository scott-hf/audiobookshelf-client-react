import { mergeClasses } from '@/lib/merge-classes'

type BadgeTone = 'neutral' | 'success' | 'error' | 'info' | 'warning'

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-black-300 text-foreground-muted',
  success: 'bg-success/20 text-success',
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
