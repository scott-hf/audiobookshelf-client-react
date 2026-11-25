import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import IconBtn from './ui/IconBtn'

interface BottomSheetProps {
  isOpen: boolean
  title: string
  onClose: () => void
  children: ReactNode
}

/**
 * Modal sheet anchored to the bottom edge, for pickers that need more room than a native
 * `<select>` gives (grouped, long, multi-section). Same dismiss contract as `ConfirmDialog`:
 * Escape or a tap on the dimmed backdrop closes it. The body scrolls inside the sheet so a long
 * option list never pushes the title and close button off screen.
 */
export default function BottomSheet({ isOpen, title, onClose, children }: BottomSheetProps) {
  const t = useTypeSafeTranslations()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  // Separate from the key listener: `onClose` is usually an inline arrow, so tying focus to it
  // would yank focus back to the panel on every parent render.
  useEffect(() => {
    // Move focus into the dialog so keyboard/TalkBack users land in it rather than behind it.
    if (isOpen) panelRef.current?.focus()
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60" role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-primary border-border shadow-modal-content flex max-h-[85vh] w-full flex-col rounded-t-lg border-t outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 id={titleId} className="text-foreground text-base font-semibold">
            {title}
          </h2>
          <IconBtn ariaLabel={t('ButtonClose')} size="small" borderless onClick={onClose}>
            close
          </IconBtn>
        </div>
        <div className="overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>
  )
}
