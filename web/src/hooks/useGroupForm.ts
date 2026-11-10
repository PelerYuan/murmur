import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
import { LIMITS, deepEqual, diffObject, parseFieldError, setPath, validateGroup } from '../lib/settingsForm'
import type { Settings, SettingsGroup } from '../lib/types'
import { useSaveSettings, useSettings } from './useData'
import { useToast } from '../components/ui/Toast'

function withRange(base: string, l?: { min: number; max?: number }): string {
  if (!l) return base
  return `${base} (${l.min}${l.max != null ? ` – ${l.max}` : '+'})`
}

export type FieldErrors = Record<string, string>

export interface GroupForm<G extends SettingsGroup> {
  draft: Settings[G]
  saved: Settings[G]
  set: (path: string, value: unknown) => void
  replace: (next: Settings[G]) => void
  dirty: boolean
  /** Field errors by path relative to the group; "_" holds an error not tied to a field. */
  errors: FieldErrors
  saving: boolean
  /** Save only the changed leaves. Resolves true on success. */
  save: () => Promise<boolean>
  discard: () => void
}

/**
 * Edit state for one settings group. Only the group's changed leaves are PUT; the server's reply replaces
 * the cache; 422 "path: message" details are attached to the matching field.
 */
export function useGroupForm<G extends SettingsGroup>(group: G, messages: { required: string; range: string; int: string }): GroupForm<G> {
  const settings = useSettings()
  const mut = useSaveSettings()
  const toast = useToast()
  const saved = settings.data![group]
  const [draft, setDraft] = useState<Settings[G]>(saved)
  const [errors, setErrors] = useState<FieldErrors>({})
  const dirtyRef = useRef(false)
  const dirty = useMemo(() => !deepEqual(saved, draft), [saved, draft])
  dirtyRef.current = dirty

  // Pick up server-side changes (another tab, SSE refetch) only while the user has not edited anything.
  useEffect(() => { if (!dirtyRef.current) setDraft(saved) }, [saved])

  const set = useCallback((path: string, value: unknown) => {
    setDraft((d) => setPath(d, path, value))
    setErrors((e) => {
      if (!(path in e) && !e._) return e
      const { [path]: _drop, _: _g, ...rest } = e
      void _drop; void _g
      return rest
    })
  }, [])

  const save = useCallback(async () => {
    const local = validateGroup(group, draft)
    if (Object.keys(local).length) {
      setErrors(Object.fromEntries(Object.entries(local).map(([p, k]) => [p, k === 'range' ? withRange(messages.range, LIMITS[`${group}.${p}`]) : messages[k]])))
      return false
    }
    const patch = diffObject(saved, draft)
    if (!patch) return true
    try {
      await mut.mutateAsync({ [group]: patch } as Partial<Record<SettingsGroup, unknown>>)
      setErrors({})
      return true
    } catch (e) {
      if (e instanceof ApiError && (e.status === 422 || e.status === 400)) {
        const f = parseFieldError(e.detail, group)
        setErrors(f ? { [f.path]: f.message } : { _: e.detail })
      } else toast.error(e)
      return false
    }
  }, [draft, saved, group, mut, toast, messages])

  const discard = useCallback(() => { setDraft(saved); setErrors({}) }, [saved])
  const replace = useCallback((next: Settings[G]) => setDraft(next), [])

  return { draft, saved, set, replace, dirty, errors, saving: mut.isPending, save, discard }
}
