import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * Block leaving while `dirty`. The app uses a plain BrowserRouter (no data-router blockers), so this
 * intercepts tab close/reload (beforeunload) and same-origin link clicks. The browser Back button
 * cannot be intercepted without a data router and is not guarded.
 * `onBlocked(proceed)` receives a function that performs the pending navigation once the user confirms.
 */
export function useUnsavedGuard(dirty: boolean, onBlocked: (proceed: () => void) => void) {
  const nav = useNavigate()
  const cb = useRef(onBlocked)
  cb.current = onBlocked

  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return
      const url = new URL(a.href, window.location.href)
      if (url.origin !== window.location.origin) return
      if (url.pathname === window.location.pathname && url.search === window.location.search) return
      e.preventDefault()
      e.stopPropagation()
      cb.current(() => nav(url.pathname + url.search + url.hash))
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [dirty, nav])
}
