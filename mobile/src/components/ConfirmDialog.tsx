interface ConfirmDialogProps {
  isOpen: boolean
  message: string
  confirmLabel: string
  confirmClassName?: string
  processing?: boolean
  onClose: () => void
  onConfirm: () => void
}

/** Minimal confirm modal for the mobile shell -- no design-system dependency, just enough to
 * mirror the web app's ConfirmDialog contract (isOpen / message / confirm / cancel /
 * processing) for the Discover confirm-exact-release and cancel-acquisition flows. */
export default function ConfirmDialog({ isOpen, message, confirmLabel, confirmClassName, processing = false, onClose, onConfirm }: ConfirmDialogProps) {
  if (!isOpen) return null
  return (
    <div className="confirm-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-dialog-message">{message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-dialog-cancel" disabled={processing} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={confirmClassName ?? 'confirm-dialog-confirm'} disabled={processing} onClick={onConfirm}>
            {processing ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
