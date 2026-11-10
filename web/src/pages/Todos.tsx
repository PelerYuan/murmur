import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, Bell, BellRing, Check, ChevronRight, Clock, ListChecks, MoreHorizontal, Pencil, Plus, RotateCcw, Search, Trash2, Undo2, UserRound } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { qk } from '../lib/queryClient'
import { minutesUntilNextMorning } from '../lib/time'
import type { Todo, TodoStatus } from '../lib/types'
import { useFmt, useMe, useSettings, useSpeakerLookup, usePipeline } from '../hooks/useData'
import { useNow } from '../hooks/useNow'
import { usePageKeys } from '../hooks/useShortcuts'
import { Page } from '../components/Page'
import { Button } from '../components/ui/Button'
import { Badge, EmptyState, ErrorBar, Skeleton, Tabs } from '../components/ui/Misc'
import { Checkbox, Input, Select, Switch } from '../components/ui/Form'
import { Menu, Popover } from '../components/ui/Popover'
import { ConfirmDialog } from '../components/ui/Confirm'
import { useToast } from '../components/ui/Toast'
import { SpeakerChip } from '../components/SpeakerChip'
import { SpeakerPickerList } from '../components/speakers/SpeakerPicker'
import { TodoDialog } from '../components/todos/TodoDialog'
import { DateTimePopover } from '../components/todos/DateTimePopover'
import { useT } from '../i18n'
import { groupTodos, type TodoGroup as Group } from '../lib/todoGroups'


export default function Todos() {
  const t = useT()
  const fmt = useFmt()
  const qc = useQueryClient()
  const toast = useToast()
  const now = useNow(30_000)
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') as TodoStatus) || 'open'
  const focusId = params.get('focus') ? Number(params.get('focus')) : null
  const [me] = useMe()
  const { list: speakers, label } = useSpeakerLookup()
  const settings = useSettings(false)
  const pipeline = usePipeline(false)
  const [assignee, setAssignee] = useState<string>('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [qRaw, setQRaw] = useState('')
  const [q, setQ] = useState('')
  const [quick, setQuick] = useState('')
  const [dialog, setDialog] = useState<{ todo?: Todo; text?: string } | null>(null)
  const [deleting, setDeleting] = useState<Todo | null>(null)
  useEffect(() => { const h = setTimeout(() => setQ(qRaw.trim()), 300); return () => clearTimeout(h) }, [qRaw])
  usePageKeys((e) => { if (e.key === '/') { e.preventDefault(); document.getElementById('todo-search')?.focus() } else if (e.key === 'n') { e.preventDefault(); document.getElementById('todo-quick')?.focus() } }, [])

  const assigneeId = onlyMine && me != null ? me : assignee ? Number(assignee) : undefined
  const list = useQuery({
    queryKey: [...qk.todos, status, assigneeId ?? null, q],
    queryFn: () => api.get<Todo[]>('/todos', { status, assignee_id: assigneeId, q: q || undefined }),
    refetchInterval: 60_000,
  })
  const openCount = useQuery({
    queryKey: [...qk.todos, 'open', null, ''],
    queryFn: () => api.get<Todo[]>('/todos', { status: 'open' }),
    enabled: status !== 'open',
  })
  const todos = list.data ?? []
  const nCount = status === 'open' ? todos.length : openCount.data?.length

  const todayEnd = fmt.range(fmt.today()).to
  const groups = useMemo(() => groupTodos(todos, now, Date.parse(todayEnd)), [todos, now, todayEnd])

  const setStatus = (v: TodoStatus) => { const p = new URLSearchParams(params); if (v === 'open') p.delete('status'); else p.set('status', v); setParams(p, { replace: true }) }
  const invalidate = () => { void qc.invalidateQueries({ queryKey: qk.todos }); void qc.invalidateQueries({ queryKey: qk.dashboard }); void qc.invalidateQueries({ queryKey: qk.reminders }) }

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patch<Todo>(`/todos/${id}`, body),
    onSuccess: invalidate,
    onError: (e) => { toast.error(e); invalidate() },
  })
  const dropFromCache = (id: number) => qc.setQueriesData<Todo[]>({ queryKey: qk.todos }, (old) => (Array.isArray(old) ? old.filter((x) => x.id !== id) : old))

  const setState = (td: Todo, next: TodoStatus, msgKey: 'todos.done_toast' | 'todos.dismiss_toast' | 'todos.restored') => {
    const prev = td.status
    dropFromCache(td.id)
    patch.mutate({ id: td.id, body: { status: next } }, {
      onSuccess: () => {
        toast.undo(t(msgKey), () => patch.mutate({ id: td.id, body: { status: prev } }))
      },
    })
  }

  const snooze = useMutation({
    mutationFn: ({ id, minutes }: { id: number; minutes: number }) => api.post<Todo>(`/todos/${id}/snooze`, { minutes }),
    onSuccess: () => { toast.success(t('todos.snoozed')); invalidate() },
    onError: (e) => toast.error(e),
  })
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/todos/${id}`),
    onSuccess: () => { toast.success(t('todos.deleted')); invalidate() },
    onError: (e) => toast.error(e),
  })
  const add = useMutation({
    mutationFn: (text: string) => api.post<Todo>('/todos', { text }),
    onSuccess: () => { setQuick(''); toast.success(t('todos.added'), 2000); invalidate() },
    onError: (e) => toast.error(e),
  })

  // ?focus=<id>: scroll the row into view and flash it.
  const [flash, setFlash] = useState<number | null>(null)
  useEffect(() => {
    if (!focusId || !list.data) return
    const el = document.querySelector<HTMLElement>(`[data-todo-id="${focusId}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      setFlash(focusId)
      const h = setTimeout(() => setFlash(null), 2200)
      return () => clearTimeout(h)
    }
  }, [focusId, list.data])

  const rowProps = { fmt, now, flash, patch: (td: Todo, body: Record<string, unknown>) => patch.mutate({ id: td.id, body }), setState, onEdit: (td: Todo) => setDialog({ todo: td }), onDelete: setDeleting, onSnooze: (td: Todo, m: number) => snooze.mutate({ id: td.id, minutes: m }) }

  const llmNote = !pipeline.data?.llm_configured || settings.data?.todos.enabled === false

  const section = (key: Group, title: string, tone?: 'danger') => groups[key].length > 0 && (
    <section key={key} aria-label={title}>
      <h3 className={cn('mb-1.5 mt-5 px-1 text-[12.5px] font-semibold uppercase tracking-wide first:mt-0', tone === 'danger' ? 'text-danger' : 'text-muted')}>{title} <span className="tabular font-normal text-faint">{groups[key].length}</span></h3>
      <ul className="card divide-y divide-line overflow-hidden">{groups[key].map((td) => <TodoRow key={td.id} todo={td} {...rowProps} />)}</ul>
    </section>
  )

  let body: React.ReactNode
  if (list.isLoading) body = <div className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
  else if (list.isError) body = <ErrorBar message={(list.error as Error).message} onRetry={() => void list.refetch()} retryLabel={t('common.retry')} />
  else if (todos.length === 0) {
    body = (
      <EmptyState
        icon={<ListChecks />}
        title={q ? t('todos.empty_search') : status === 'done' ? t('todos.empty_done') : status === 'dismissed' ? t('todos.empty_dismissed') : llmNote ? t('todos.empty_nollm') : t('todos.empty')}
      />
    )
  } else if (status === 'open') {
    body = (
      <div>
        {section('overdue', t('todos.group_overdue'), 'danger')}
        {section('today', t('todos.group_today'))}
        {section('later', t('todos.group_later'))}
        {section('nodue', t('todos.group_nodue'))}
      </div>
    )
  } else {
    body = <ul className="card divide-y divide-line overflow-hidden">{todos.map((td) => <TodoRow key={td.id} todo={td} {...rowProps} />)}</ul>
  }

  return (
    <Page title={t('todos.title')} wide={false} className="max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Tabs
          label={t('todos.title')}
          value={status}
          onChange={setStatus}
          items={[
            { value: 'open', label: t('todos.tab_open'), count: nCount },
            { value: 'done', label: t('todos.tab_done') },
            { value: 'dismissed', label: t('todos.tab_dismissed') },
          ]}
        />
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Select className="w-36" value={onlyMine ? '' : assignee} disabled={onlyMine} onChange={(e) => setAssignee(e.target.value)} aria-label={t('todos.assignee')}>
            <option value="">{t('todos.assignee_all')}</option>
            {speakers.filter((s) => s.state === 'named').map((s) => <option key={s.id} value={s.id}>{label(s.id)}</option>)}
          </Select>
          <label className={cn('flex items-center gap-2 whitespace-nowrap text-[13px]', me == null ? 'text-faint' : 'text-muted')} title={me == null ? t('me.desc') : undefined}>
            <Switch checked={onlyMine && me != null} disabled={me == null} onChange={setOnlyMine} label={t('todos.only_mine')} />
            {t('todos.only_mine')}
          </label>
          <Input id="todo-search" className="min-w-0 flex-1 sm:w-48 sm:flex-none" leading={<Search className="h-4 w-4" />} value={qRaw} onChange={(e) => setQRaw(e.target.value)} placeholder={t('todos.search')} aria-label={t('todos.search')} />
        </div>
      </div>

      {status === 'open' && (
        <form
          className="mb-5 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); if (quick.trim()) add.mutate(quick.trim()) }}
        >
          <Input id="todo-quick" className="flex-1" leading={<Plus className="h-4 w-4" />} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={t('todos.add_placeholder')} aria-label={t('todos.add_aria')} enterKeyHint="done" />
          <Button onClick={() => setDialog({ text: quick.trim() })} className="max-sm:hidden">{t('todos.add_more')}</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!quick.trim()} className="sm:hidden" aria-label={t('common.add')}><Plus className="h-4 w-4" /></Button>
        </form>
      )}
      {body}

      <TodoDialog
        open={!!dialog}
        onClose={() => { if (dialog?.text !== undefined) setQuick(''); setDialog(null) }}
        todo={dialog?.todo}
        draft={dialog?.text ? { text: dialog.text } : undefined}
      />
      <ConfirmDialog
        open={!!deleting}
        danger
        title={t('todos.delete_title')}
        body={deleting ? <><p className="font-medium">{deleting.text}</p><p className="mt-1">{t('todos.delete_body')}</p></> : null}
        confirmLabel={t('common.delete')}
        onClose={() => setDeleting(null)}
        onConfirm={async () => { if (deleting) await del.mutateAsync(deleting.id); setDeleting(null) }}
      />
    </Page>
  )
}

interface RowProps {
  todo: Todo
  fmt: ReturnType<typeof useFmt>
  now: number
  flash: number | null
  patch: (td: Todo, body: Record<string, unknown>) => void
  setState: (td: Todo, next: TodoStatus, msg: 'todos.done_toast' | 'todos.dismiss_toast' | 'todos.restored') => void
  onEdit: (td: Todo) => void
  onDelete: (td: Todo) => void
  onSnooze: (td: Todo, minutes: number) => void
}

function TodoRow({ todo, fmt, now, flash, patch, setState, onEdit, onDelete, onSnooze }: RowProps) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(todo.text)
  const [editedAt, setEditedAt] = useState(todo.updated_at)
  const [open, setOpen] = useState(false)
  const [pop, setPop] = useState<'due' | 'remind' | 'who' | null>(null)
  const dueBtn = useRef<HTMLButtonElement>(null)
  const remBtn = useRef<HTMLButtonElement>(null)
  const whoBtn = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const isOpen = todo.status === 'open'
  const overdue = isOpen && !!todo.due_at && Date.parse(todo.due_at) < now
  const stale = editing && todo.updated_at !== editedAt
  const guess = todo.source === 'auto' && todo.confidence != null && todo.confidence < 0.8

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  const startEdit = () => { if (!isOpen) return; setDraft(todo.text); setEditedAt(todo.updated_at); setEditing(true) }
  const commit = () => {
    const v = draft.trim()
    setEditing(false)
    if (v && v !== todo.text) patch(todo, { text: v })
  }

  const remindIcon = todo.reminder_state === 'fired' ? <BellRing className="h-3.5 w-3.5" /> : todo.reminder_state === 'acked' ? <Check className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />
  const remindTitle = todo.remind_at
    ? `${t('todos.remind_at', { t: fmt.due(todo.remind_at) })} · ${t(`todos.remind_state_${todo.reminder_state === 'none' ? 'pending' : todo.reminder_state}` as 'todos.remind_state_pending')}`
    : t('todos.remind_set')

  return (
    <li data-todo-id={todo.id} className={cn('px-3 py-3 sm:px-4', flash === todo.id && 'animate-flash', !isOpen && 'bg-subtle/40')}>
      <div className="flex items-start gap-3">
        <Checkbox
          round
          className="mt-0.5"
          checked={todo.status === 'done'}
          onChange={() => (isOpen ? setState(todo, 'done', 'todos.done_toast') : setState(todo, 'open', 'todos.restored'))}
          hideLabel={isOpen ? t('todos.complete_aria', { text: todo.text }) : t('todos.reopen_aria', { text: todo.text })}
        />
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); commit() }
                  if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
                }}
                aria-label={t('todos.f_text')}
                className="h-9 w-full rounded-lg border border-accent bg-surface px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/25 max-sm:text-base"
              />
              {stale && <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-warn" title={t('todos.updated_dot')}><span className="h-1.5 w-1.5 rounded-full bg-warn" />{t('todos.updated_dot')}</span>}
            </div>
          ) : (
            <button type="button" onClick={startEdit} disabled={!isOpen} className={cn('block w-full break-words text-left text-[15px] leading-6', !isOpen && 'text-muted line-through decoration-faint', isOpen && 'cursor-text')}>
              {todo.text}
            </button>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <button
              ref={dueBtn}
              type="button"
              onClick={() => setPop('due')}
              disabled={!isOpen}
              title={todo.due_at ? `${fmt.full(todo.due_at)}` : t('todos.due_set')}
              className={cn('inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs transition-colors max-sm:h-8', overdue ? 'bg-danger-soft font-medium text-danger' : todo.due_at ? 'bg-subtle text-muted hover:bg-hover' : 'text-faint hover:bg-hover', !isOpen && 'pointer-events-none')}
            >
              <Clock className="h-3 w-3" aria-hidden />
              {todo.due_at ? fmt.due(todo.due_at) : t('todos.due_none')}
            </button>
            {(isOpen || todo.remind_at) && (
              <button
                ref={remBtn}
                type="button"
                onClick={() => setPop('remind')}
                disabled={!isOpen}
                title={remindTitle}
                aria-label={remindTitle}
                className={cn('inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs transition-colors max-sm:h-8', todo.reminder_state === 'fired' ? 'bg-warn-soft text-warn' : todo.remind_at ? 'bg-subtle text-muted hover:bg-hover' : 'text-faint hover:bg-hover', !isOpen && 'pointer-events-none')}
              >
                {remindIcon}
                {todo.remind_at ? fmt.due(todo.remind_at) : <span className="sr-only">{t('todos.remind_set')}</span>}
              </button>
            )}
            <button ref={whoBtn} type="button" onClick={() => setPop('who')} disabled={!isOpen} aria-label={t('todos.f_assignee')} className={cn('inline-flex items-center', !isOpen && 'pointer-events-none')}>
              {todo.assignee_speaker_id != null
                ? <SpeakerChip speakerId={todo.assignee_speaker_id} fallbackName={todo.assignee_name} size="sm" />
                : <span className="inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-xs text-faint hover:bg-hover max-sm:h-8"><UserRound className="h-3 w-3" />{t('common.unassigned')}</span>}
            </button>
            {todo.source === 'auto' && <Badge tone="neutral" title={todo.confidence != null ? t('todos.badge_guess_title', { c: todo.confidence.toFixed(2) }) : undefined}>{t('todos.badge_auto')}</Badge>}
            {guess && <Badge tone="warn" title={t('todos.badge_guess_title', { c: todo.confidence!.toFixed(2) })}>{t('todos.badge_guess')}</Badge>}
            {(todo.source_excerpt || todo.source_utterance_id != null || todo.source === 'auto') && (
              <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex h-6 items-center gap-0.5 rounded-md px-1 text-xs text-muted hover:bg-hover hover:text-fg max-sm:h-8">
                <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
                {t('todos.source')}
              </button>
            )}
          </div>
          {open && (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-subtle px-3 py-2 text-[13px] text-muted">
              {todo.source_excerpt ? <span className="min-w-0 flex-1 break-words">“{todo.source_excerpt}”</span> : <span className="flex-1">{t('todos.source_deleted')}</span>}
              {todo.source_utterance_id != null
                ? <Link to={`/timeline?around=${todo.source_utterance_id}`} className="shrink-0 font-medium text-accent hover:underline">{t('todos.source_view')}</Link>
                : todo.source_excerpt ? <span className="shrink-0 text-xs text-faint">{t('todos.source_deleted')}</span> : null}
            </div>
          )}
        </div>
        <Menu
          label={t('todos.menu_aria')}
          items={isOpen ? [
            { label: t('todos.menu_edit'), icon: <Pencil />, onSelect: () => onEdit(todo) },
            { label: t('todos.menu_dismiss'), icon: <Undo2 />, onSelect: () => setState(todo, 'dismissed', 'todos.dismiss_toast') },
            { label: t('todos.menu_snooze_10'), icon: <AlarmClock />, divider: true, onSelect: () => onSnooze(todo, 10) },
            { label: t('todos.menu_snooze_60'), icon: <AlarmClock />, onSelect: () => onSnooze(todo, 60) },
            { label: t('todos.menu_snooze_morning'), icon: <AlarmClock />, onSelect: () => onSnooze(todo, minutesUntilNextMorning(Date.now(), fmt.tz)) },
            { label: t('todos.menu_delete'), icon: <Trash2 />, danger: true, divider: true, onSelect: () => onDelete(todo) },
          ] : [
            { label: t('todos.menu_restore'), icon: <RotateCcw />, onSelect: () => setState(todo, 'open', 'todos.restored') },
            { label: t('todos.menu_delete'), icon: <Trash2 />, danger: true, divider: true, onSelect: () => onDelete(todo) },
          ]}
          trigger={<button type="button" aria-label={t('todos.menu_aria')} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg max-sm:h-10 max-sm:w-10"><MoreHorizontal className="h-4 w-4" /></button>}
        />
      </div>
      <DateTimePopover open={pop === 'due'} anchor={dueBtn.current} onClose={() => setPop(null)} value={todo.due_at} label={t('todos.f_due')} onSave={(iso) => patch(todo, { due_at: iso })} />
      <DateTimePopover open={pop === 'remind'} anchor={remBtn.current} onClose={() => setPop(null)} value={todo.remind_at} label={t('todos.f_remind')} onSave={(iso) => patch(todo, { remind_at: iso })} />
      <Popover open={pop === 'who'} onClose={() => setPop(null)} anchor={whoBtn.current} label={t('todos.f_assignee')} className="border border-line">
        <div className="w-[300px] p-2.5">
          <SpeakerPickerList
            selectedId={todo.assignee_speaker_id}
            maxHeight="max-h-[260px]"
            onNone={() => { setPop(null); patch(todo, { assignee_speaker_id: null }) }}
            noneLabel={t('common.unassigned')}
            onSelect={(s) => { setPop(null); patch(todo, { assignee_speaker_id: s.id }) }}
          />
        </div>
      </Popover>
    </li>
  )
}
