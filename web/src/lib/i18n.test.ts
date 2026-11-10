import { describe, expect, it } from 'vitest'
import { interpolate, translate } from '../i18n/core'
import { dicts } from '../i18n'

describe('translate fallback', () => {
  const d = { zh: { a: '甲 {n}', onlyzh: '仅中文' }, en: { a: 'A {n}' } }
  it('uses the requested language', () => expect(translate(d, 'en', 'a', { n: 2 })).toBe('A 2'))
  it('falls back to Chinese when the key is missing in the language', () => expect(translate(d, 'en', 'onlyzh')).toBe('仅中文'))
  it('falls back to the key itself when nothing has it', () => expect(translate(d, 'en', 'nope.key')).toBe('nope.key'))
  it('leaves unknown placeholders intact', () => expect(interpolate('hi {who}', { x: 1 })).toBe('hi {who}'))
})

describe('shipped dictionaries', () => {
  it('zh and en define exactly the same keys', () => {
    expect(Object.keys(dicts.en).sort()).toEqual(Object.keys(dicts.zh).sort())
  })
  it('placeholders match between languages', () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
    const bad = Object.keys(dicts.zh).filter((k) => ph(dicts.zh[k]) !== ph(dicts.en[k]))
    expect(bad).toEqual([])
  })
  it('no empty strings', () => {
    expect(Object.entries(dicts.zh).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([])
    expect(Object.entries(dicts.en).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([])
  })
})
