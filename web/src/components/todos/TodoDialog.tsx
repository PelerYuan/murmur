import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Quote } from 'lucide-react'
import { api } from '../../lib/api'
import { qk } from '../../lib/queryClient'
import { fromLocalInput, toLocalInput } from '../../lib/time'
import type { Todo } from '../../lib/types'
import { useFmt, useSettings, useSpeakerLookup } from '../../hooks/useData'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Field, Input, Select, Textarea } from '../ui/Form'
import { useToast } from '../ui/Toast'
import { useT } from '../../i18n'

export interface TodoDraft {
  text?: string
  due_at?: string | null
  remind_at?: string | null
  assignee_speaker_id?: number | null
  source_utterance_id?: number | null
  source_excerpt?: string | null
}

/** Create or edit a to-do. Setting a due time prefills remind = due − default lead (user can change/clear). */
export function TodoDialog({ open, onClose, todo, draft, title, onSaved }: {
  open: boolean; onClose: () => void; todo?: Todo | null; draft?: TodoDraft; title?: string; onSaved?: (t: Todo) => void
}) {
  const t = useT()
  const fmt = useFmt()
  const qc = useQueryClient()
  const toast = useToast()
  const settings = useSettings(false)
  const lead = settings.data?.todos.default_remind_before_minutes ?? 10
  const { list, label } = useSpeakerLookup()
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [remind, setRemind] = useState('')
  const [remindTouched, setRemindTouched] = useState(false)
  const [assignee, setAssignee] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const src = todo ?? draft ?? {}
    setText(src.text ?? '')
    setDue(toLocalInput(src.due_at, fmt.tz))
    setRemind(toLocalInput(src.remind_at, fmt.tz))
    setRemindTouched(!!src.remind_at)
    setAssignee(src.assignee_speaker_id ?? null)
    setErr(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, todo?.id])

  const onDue = (v: string) => {
    setDue(v)
    if (!remindTouched) {
      const iso = fromLocalInput(v, fmt.tz)
      setRemind(iso ? toLocalInput(new Date(Date.parse(iso) - lead * 60000).toISOString(), fmt.tz) : '')
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        text: text.trim(),
        due_at: due ? fromLocalInput(due, fmt.tz) : null,
        remind_at: remind ? fromLocalInput(remind, fmt.tz) : null,
        assignee_speaker_id: assignee,
      }
      if (todo) {
        // Only send what changed so an untouched reminder keeps its state.
        const patch: Record<string, unknown> = {}
        if (body.text !== todo.text) patch.text = body.text
        if (body.due_at !== todo.due_at) patch.due_at = body.due_at
        if (body.remind_at !== todo.remind_at) patch.remind_at = body.remind_at
        if (body.assignee_speaker_id !== todo.assignee_speaker_id) patch.assignee_speaker_id = body.assignee_speaker_id
        return Object.keys(patch).length ? api.patch<Todo>(`/todos/${todo.id}`, patch) : todo
      }
      return api.post<Todo>('/todos', { ...body, ...(draft?.source_utterance_id ? { source_utterance_id: draft.source_utterance_id } : {}) })
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.todos })
      void qc.invalidateQueries({ queryKey: qk.dashboard })
      void qc.invalidateQueries({ queryKey: qk.reminders })
      toast.success(t('todos.added'))
      onSaved?.(res)
      onClose()
    },
    onError: (e) => toast.error(e),
  })

  const speakers = useMemo(() => list.filter((s) => s.state !== 'ignored'), [list])
  const submit = () => {
    if (!text.trim()) return setErr(t('todos.f_text_required'))
    if (due && remind && Date.parse(fromLocalInput(remind, fmt.tz) ?? '') > Date.parse(fromLocalInput(due, fmt.tz) ?? '')) return setErr(t('todos.f_remind_after_due'))
    setErr(null)
    save.mutate()
  }
  const excerpt = todo?.source_excerpt ?? draft?.source_excerpt

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? (todo ? t('todos.dialog_edit') : t('todos.dialog_new'))}
      size="md"
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} onClick={submit}>{t('common.save')}</Button></>}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <Field label={t('todos.f_text')} error={err && err === t('todos.f_text_required') ? err : undefined}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} data-autofocus onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('todos.f_due')} optional={t('common.optional')}>
            <Input type="datetime-local" value={due} onChange={(e) => onDue(e.target.value)} />
          </Field>
          <Field label={t('todos.f_remind')} optional={t('common.optional')} error={err === t('todos.f_remind_after_due') ? err : undefined}>
            <Input type="datetime-local" value={remind} onChange={(e) => { setRemind(e.target.value); setRemindTouched(true) }} />
          </Field>
        </div>
        <p className="-mt-2 text-xs text-muted">{t('todos.f_remind_hint', { n: lead })} {t('todos.f_tz_hint', { tz: fmt.tz })}</p>
        <Field label={t('todos.f_assignee')} optional={t('common.optional')}>
          <Select value={assignee ?? ''} onChange={(e) => setAssignee(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('common.none')}</option>
            {speakers.map((s) => <option key={s.id} value={s.id}>{label(s.id)}</option>)}
          </Select>
        </Field>
        {excerpt && (
          <div className="flex gap-2 rounded-lg bg-subtle px-3 py-2 text-[13px] text-muted">
            <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span><span className="font-medium text-fg">{t('todos.f_source')}：</span>{excerpt}</span>
          </div>
        )}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  )
}
