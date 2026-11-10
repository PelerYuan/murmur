import { useEffect, useMemo } from 'react'
import { useT } from '../../../i18n'

export interface GroupProps { onDirty: (dirty: boolean) => void }

export function useFormMessages() {
  const t = useT()
  return useMemo(() => ({ required: t('set.err_required'), range: t('set.err_range'), int: t('set.err_int') }), [t])
}

export function useReportDirty(dirty: boolean, onDirty: (d: boolean) => void) {
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])
}
