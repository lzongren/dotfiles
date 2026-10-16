import { useEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react'

export function useDismiss(open: boolean, close: () => void, within: string) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest(within))) closeRef.current()
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open, within])
  return {
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== 'Escape' || !open) return
      close()
      event.currentTarget.querySelector<HTMLElement>('[aria-expanded]')?.focus()
    },
    onBlur(event: FocusEvent<HTMLElement>) {
      const root = event.currentTarget
      const next = event.relatedTarget
      if (next instanceof Node) {
        if (!root.contains(next)) close()
        return
      }
      window.setTimeout(() => {
        if (document.hasFocus() && !root.contains(document.activeElement)) closeRef.current()
      })
    },
  }
}
