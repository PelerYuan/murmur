import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

const GO: Record<string, string> = { d: '/', t: '/timeline', s: '/summaries', o: '/todos', p: '/speakers', r: '/recorders', c: '/settings' }

/** Global shortcuts: `g` then a letter navigates; `?` opens the help panel. Ignored while typing. */
export function useGlobalShortcuts(openHelp: () => void) {
  const nav = useNavigate()
  useEffect(() => {
    let pending = false
    let timer: ReturnType<typeof setTimeout>
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
      if (document.querySelector('[role=dialog][aria-modal=true]')) return
      if (pending) {
        pending = false
        clearTimeout(timer)
        const to = GO[e.key.toLowerCase()]
        if (to) { e.preventDefault(); nav(to) }
        return
      }
      if (e.key === 'g') {
        pending = true
        timer = setTimeout(() => { pending = false }, 1200)
      } else if (e.key === '?') {
        e.preventDefault()
        openHelp()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(timer) }
  }, [nav, openHelp])
}

/** Page-level key handler that is skipped while typing or while a modal is open. */
export function usePageKeys(handler: (e: KeyboardEvent) => void, deps: unknown[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
      if (document.querySelector('[role=dialog][aria-modal=true]')) return
      handler(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
