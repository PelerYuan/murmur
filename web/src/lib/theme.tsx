import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { lsGet, lsSet } from './storage'

export type ThemePref = 'system' | 'light' | 'dark'
interface Ctx { pref: ThemePref; resolved: 'light' | 'dark'; setPref: (p: ThemePref) => void }
const ThemeContext = createContext<Ctx | null>(null)

function readPref(): ThemePref {
  const v = lsGet('murmur.theme')
  return v === 'light' || v === 'dark' ? v : 'system'
}
const sysDark = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref)
  const [dark, setDark] = useState(sysDark)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const resolved: 'light' | 'dark' = pref === 'system' ? (dark ? 'dark' : 'light') : pref
  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', resolved === 'dark' ? '#111110' : '#fafaf8')
  }, [resolved])
  const setPref = useCallback((p: ThemePref) => { lsSet('murmur.theme', p === 'system' ? null : p); setPrefState(p) }, [])
  return <ThemeContext.Provider value={{ pref, resolved, setPref }}>{children}</ThemeContext.Provider>
}

export function useTheme(): Ctx {
  const c = useContext(ThemeContext)
  if (!c) throw new Error('ThemeProvider missing')
  return c
}
