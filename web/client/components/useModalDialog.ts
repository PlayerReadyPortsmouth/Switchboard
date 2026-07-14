import { useEffect, useRef } from "react"

export function useModalDialog(onCancel: () => void | boolean) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef(onCancel)
  const restoreRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  cancelRef.current = onCancel
  const restoreFocus = () => queueMicrotask(() => { if (restoreRef.current?.isConnected) restoreRef.current.focus() })
  const cancel = () => {
    if (cancelRef.current() === false) { dialogRef.current?.focus(); return false }
    restoreFocus()
    return true
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const handleCancel = (event: Event) => { event.preventDefault(); cancel() }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener("cancel", handleCancel)
    dialog.addEventListener("keydown", handleKeyDown)
    dialog.showModal()
    return () => {
      dialog.removeEventListener("cancel", handleCancel)
      dialog.removeEventListener("keydown", handleKeyDown)
      if (dialog.open) dialog.close()
    }
  }, [])
  return { dialogRef, cancel }
}
