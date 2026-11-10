import { useCallback, useState, type ComponentType } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Overlay'
import { Select } from '../components/ui/Form'
import { Skeleton } from '../components/ui/Misc'
import { Page } from '../components/Page'
import { useSettings } from '../hooks/useData'
import { useUnsavedGuard } from '../hooks/useUnsavedGuard'
import { cn } from '../lib/cn'
import { useT, type TKey } from '../i18n'
import GeneralGroup from '../components/settings/groups/GeneralGroup'
import AsrGroup from '../components/settings/groups/AsrGroup'
import LlmGroup from '../components/settings/groups/LlmGroup'
import SpeakersGroup from '../components/settings/groups/SpeakersGroup'
import FiltersGroup from '../components/settings/groups/FiltersGroup'
import RetentionGroup from '../components/settings/groups/RetentionGroup'
import ScheduleGroup from '../components/settings/groups/ScheduleGroup'
import TodosGroup from '../components/settings/groups/TodosGroup'
import SecurityGroup from '../components/settings/groups/SecurityGroup'
import SystemGroup from '../components/settings/groups/SystemGroup'
import type { GroupProps } from '../components/settings/groups/shared'

type Section = 'general' | 'asr' | 'llm' | 'speakers' | 'filters' | 'retention' | 'schedule' | 'todos' | 'security' | 'system'
const SECTIONS: { id: Section; label: TKey; desc: TKey; C: ComponentType<GroupProps> }[] = [
  { id: 'general', label: 'set.g_general', desc: 'set.g_general_desc', C: GeneralGroup },
  { id: 'asr', label: 'set.g_asr', desc: 'set.g_asr_desc', C: AsrGroup },
  { id: 'llm', label: 'set.g_llm', desc: 'set.g_llm_desc', C: LlmGroup },
  { id: 'speakers', label: 'set.g_speakers', desc: 'set.g_speakers_desc', C: SpeakersGroup },
  { id: 'filters', label: 'set.g_filters', desc: 'set.g_filters_desc', C: FiltersGroup },
  { id: 'retention', label: 'set.g_retention', desc: 'set.g_retention_desc', C: RetentionGroup },
  { id: 'schedule', label: 'set.g_schedule', desc: 'set.g_schedule_desc', C: ScheduleGroup },
  { id: 'todos', label: 'set.g_todos', desc: 'set.g_todos_desc', C: TodosGroup },
  { id: 'security', label: 'set.g_security', desc: 'set.g_security_desc', C: SecurityGroup as unknown as ComponentType<GroupProps> },
  { id: 'system', label: 'set.g_system', desc: 'set.g_system_desc', C: SystemGroup as unknown as ComponentType<GroupProps> },
]

export default function Settings() {
  const t = useT()
  const nav = useNavigate()
  const { section } = useParams<{ section?: string }>()
  const settings = useSettings()
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<(() => void) | null>(null)
  const onDirty = useCallback((d: boolean) => setDirty(d), [])
  useUnsavedGuard(dirty, (go) => setPending(() => go))

  const current = SECTIONS.find((s) => s.id === section)
  if (!current) return <Navigate to="/settings/general" replace />
  const { C } = current

  return (
    <Page title={t('set.title')} docTitle={`${t(current.label)} · ${t('set.title')}`}>
      <div className="grid gap-5 md:grid-cols-[200px_minmax(0,1fr)] md:gap-8">
        <div className="md:hidden">
          <Select
            aria-label={t('set.title')}
            value={current.id}
            onChange={(e) => {
              const to = `/settings/${e.target.value}`
              if (dirty) setPending(() => () => nav(to)); else nav(to)
            }}
          >
            {SECTIONS.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}
          </Select>
        </div>
        <nav aria-label={t('set.title')} className="hidden md:block">
          <ul className="sticky top-4 space-y-0.5">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <Link
                  to={`/settings/${s.id}`}
                  aria-current={s.id === current.id ? 'page' : undefined}
                  className={cn('block rounded-lg px-3 py-2 text-sm font-medium transition-colors', s.id === current.id ? 'bg-fg text-bg' : 'text-muted hover:bg-hover hover:text-fg')}
                >
                  {t(s.label)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 max-w-[720px]">
          <header className="mb-4">
            <h3 className="text-lg font-semibold tracking-tight">{t(current.label)}</h3>
            <p className="mt-0.5 text-[13px] text-muted">{t(current.desc)}</p>
          </header>
          {settings.data ? <C key={current.id} onDirty={onDirty} /> : <Skeleton className="h-64 rounded-xl" />}
        </div>
      </div>
      <Dialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={t('set.leave_title')}
        size="sm"
        footer={
          <>
            <Button onClick={() => setPending(null)}>{t('set.leave_stay')}</Button>
            <Button variant="danger" onClick={() => { const go = pending; setPending(null); setDirty(false); go?.() }}>{t('set.leave_discard')}</Button>
          </>
        }
      >
        <p className="text-sm text-muted">{t('set.leave_body')}</p>
      </Dialog>
    </Page>
  )
}
