import { useEffect, useState } from 'react'

export function useMedia(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof matchMedia !== 'undefined' ? matchMedia(query).matches : false)
  const [m, setM] = useState(get)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return m
}

/** < 640px: phone layout (bottom tab bar, bottom-sheet menus). */
export const useIsMobile = () => useMedia('(max-width: 639px)')
