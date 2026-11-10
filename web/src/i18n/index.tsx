import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { translate, type Dict, type Lang, type Params } from './core'
import { lsGet, lsSet } from '../lib/storage'

import common from './dict/common'
import shell from './dict/shell'
import dashboard from './dict/dashboard'
import timeline from './dict/timeline'
import summaries from './dict/summaries'
import todos from './dict/todos'
import speakers from './dict/speakers'
import recorders from './dict/recorders'
import settings from './dict/settings'
import welcome from './dict/welcome'

const parts = [common, shell, dashboard, timeline, summaries, todos, speakers, recorders, settings, welcome]
export const dicts: Record<Lang, Dict> = {
  zh: Object.assign({}, ...parts.map((p) => p.zh)),
  en: Object.assign({}, ...parts.map((p) => p.en)),
}

export type TKey = keyof (typeof common.zh & typeof shell.zh & typeof dashboard.zh & typeof timeline.zh & typeof summaries.zh &
  typeof todos.zh & typeof speakers.zh & typeof recorders.zh & typeof settings.zh & typeof welcome.zh)

export type TFunc = (key: TKey, params?: Params) => string

interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: TFunc }
const I18nContext = createContext<Ctx | null>(null)

export function detectLang(): Lang {
  const saved = lsGet('murmur.lang')
  return saved === 'en' || saved === 'zh' ? saved : 'zh'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang)
  const setLang = useCallback((l: Lang) => {
    lsSet('murmur.lang', l)
    setLangState(l)
  }, [])
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])
  const value = useMemo<Ctx>(() => ({ lang, setLang, t: (key, params) => translate(dicts, lang, key, params) }), [lang, setLang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext)
  if (!c) throw new Error('I18nProvider missing')
  return c
}
export function useT(): TFunc {
  return useI18n().t
}
export type { Lang, Params }
