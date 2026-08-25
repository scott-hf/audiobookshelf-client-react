import { useEffect } from 'react'
import Btn from './ui/Btn'

interface ConfirmDialogProps {
  isOpen: boolean
  message: string
  confirmLabel: string
  /** Tailwind background utility for the confirm button (e.g. `bg-error` for destructive actions). */
  confirmColor?: string
  processing?: boolean
  onClose: () => void
  onConfirm: () => void
}

/** Confirm modal for the mobile shell -- mirrors the web app's ConfirmDialog contract
 * (isOpen / message / confirm / cancel / processing) for the Discover confirm-exact-release
 * and cancel-acquisition flows, built from the ported ui/ primitives. */
export default function ConfirmDialog({ isOpen, message, confirmLabel, confirmColor = 'bg-accent', processing = false, onClose, onConfirm }: ConfirmDialogProps) {
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !processing) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, processing, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation" onClick={onClose}>
      <div
        className="bg-primary border-border shadow-modal-content w-full max-w-sm rounded-lg border p-5"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-foreground text-center text-base">{message}</p>
        <div className="mt-5 flex gap-2">
          <Btn size="small" color="bg-black-300" disabled={processing} onClick={onClose} className="flex-1 justify-center">
            Cancel
          </Btn>
          <Btn size="small" color={confirmColor} disabled={processing} loading={processing} onClick={onConfirm} className="flex-1 justify-center">
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  )
}
