import { useLayoutEffect, useState, type RefObject } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'

/** The app shell scrolls `<main id="main">`; lists virtualise against it with a margin for the content above them. */
export function useMainScroller(): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { setEl(document.getElementById('main')) }, [])
  return el
}

export function useMainVirtualizer(opts: {
  count: number
  estimate: number | ((i: number) => number)
  container: RefObject<HTMLElement>
  overscan?: number
  getKey?: (i: number) => string | number
}): { virt: Virtualizer<HTMLElement, Element>; margin: number; scroller: HTMLElement | null } {
  const scroller = useMainScroller()
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    const c = opts.container.current
    if (!c || !scroller) return
    const m = Math.round(c.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)
    if (Math.abs(m - margin) > 1) setMargin(m)
  })
  const virt = useVirtualizer<HTMLElement, Element>({
    count: opts.count,
    getScrollElement: () => scroller,
    estimateSize: (i) => (typeof opts.estimate === 'function' ? opts.estimate(i) : opts.estimate),
    overscan: opts.overscan ?? 8,
    scrollMargin: margin,
    getItemKey: opts.getKey,
  })
  return { virt, margin, scroller }
}
