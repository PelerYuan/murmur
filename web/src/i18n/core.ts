export type Lang = 'zh' | 'en'
export type Dict = Record<string, string>

/** Define one domain's strings; TypeScript guarantees `en` has exactly the keys of `zh`. */
export function defineDict<T extends Record<string, string>>(zh: T, en: Record<keyof T, string>) {
  return { zh, en: en as Dict }
}

export type Params = Record<string, string | number>

export function interpolate(s: string, params?: Params): string {
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

/** Look up `key` in `lang`; fall back to Chinese (the source language), then to the key itself. */
export function translate(dicts: Record<Lang, Dict>, lang: Lang, key: string, params?: Params): string {
  const s = dicts[lang]?.[key] ?? dicts.zh?.[key] ?? key
  return interpolate(s, params)
}
