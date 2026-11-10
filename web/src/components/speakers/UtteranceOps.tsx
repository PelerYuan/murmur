import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { api } from '../../lib/api'
import type { Speaker, Utterance } from '../../lib/types'
import { emitUtteranceChange } from '../../lib/utteranceBus'
import { useSpeakerLookup } from '../../hooks/useData'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Form'
import { ProgressBar } from '../ui/Misc'
import { ConfirmDialog } from '../ui/Confirm'
import { useToast } from '../ui/Toast'
import { SpeakerPickerList } from './SpeakerPicker'
import { SpeakerDot } from '../SpeakerChip'
import { TodoDialog, type TodoDraft } from '../todos/TodoDialog'
import { useT } from '../../i18n'

interface Ops {
  /** Pick a speaker and reassign (single or many). Single/same-source selections also offer "split to new speaker". */
  reassign: (utts: Utterance[], onDone?: () => void) => void
  /** Split these (same-speaker) utterances into a new unnamed speaker. */
  split: (utts: Utterance[], onDone?: () => void) => void
  editText: (u: Utterance) => void
  remove: (utts: Utterance[], onDone?: () => void) => void
  createTodo: (u: Utterance) => void
}
const Ctx = createContext<Ops | null>(null)
export function useUtteranceOps(): Ops {
  const c = useContext(Ctx)
  if (!c) throw new Error('UtteranceOpsProvider missing')
  return c
}

const CONCURRENCY = 4

export function UtteranceOpsProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const { label, map } = useSpeakerLookup()

  const [picking, setPicking] = useState<{ utts: Utterance[]; onDone?: () => void } | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; failed: Utterance[]; target: number | null } | null>(null)
  const [splitDone, setSplitDone] = useState<{ speaker: Speaker | { id: number; display_name?: string }; n: number } | null>(null)
  const [editing, setEditing] = useState<Utterance | null>(null)
  const [editText, setEditText] = useState('')
  const [deleting, setDeleting] = useState<{ utts: Utterance[]; onDone?: () => void } | null>(null)
  const [todoFrom, setTodoFrom] = useState<Utterance | null>(null)
  const pendingDone = useRef<(() => void) | undefined>()

  const refresh = useCallback(() => {
    for (const key of [['speakers'], ['speaker'], ['feed'], ['utterances'], ['dashboard']]) void qc.invalidateQueries({ queryKey: key })
  }, [qc])

  const runReassign = useCallback(async (utts: Utterance[], target: number | null) => {
    setProgress({ done: 0, total: utts.length, failed: [], target })
    const failed: Utterance[] = []
    const okIds: number[] = []
    let done = 0
    let i = 0
    const worker = async () => {
      while (i < utts.length) {
        const u = utts[i++]
        try {
          await api.patch<Utterance>(`/utterances/${u.id}`, { speaker_id: target })
          okIds.push(u.id)
        } catch { failed.push(u) }
        done++
        setProgress({ done, total: utts.length, failed: [...failed], target })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, utts.length) }, worker))
    if (okIds.length) emitUtteranceChange({ type: 'reassign', ids: okIds, speakerId: target })
    refresh()
    return { okIds, failed }
  }, [refresh])

  const finishReassign = useCallback((utts: Utterance[], target: number | null, okIds: number[], failed: Utterance[]) => {
    if (failed.length === 0) {
      setProgress(null)
      const prev = new Map(utts.map((u) => [u.id, u.speaker_id]))
      const name = target == null ? t('speaker.unknown') : label(target)
      const msg = utts.length === 1 ? t('speakers.reassign_ok', { name }) : t('speakers.reassign_done', { n: utts.length })
      toast.undo(msg, () => {
        // Undo: restore each utterance's previous speaker.
        void (async () => {
          const groups = new Map<number | null, number[]>()
          for (const id of okIds) { const p = prev.get(id) ?? null; groups.set(p, [...(groups.get(p) ?? []), id]) }
          await Promise.all(okIds.map((id) => api.patch(`/utterances/${id}`, { speaker_id: prev.get(id) ?? null }).catch(() => undefined)))
          for (const [sp, ids] of groups) emitUtteranceChange({ type: 'reassign', ids, speakerId: sp })
          refresh()
        })()
      })
      pendingDone.current?.()
      pendingDone.current = undefined
    }
  }, [label, refresh, t, toast])

  const doReassign = useCallback(async (utts: Utterance[], target: number | null) => {
    setPicking(null)
    const { okIds, failed } = await runReassign(utts, target)
    finishReassign(utts, target, okIds, failed)
  }, [runReassign, finishReassign])

  const doSplit = useCallback(async (utts: Utterance[]) => {
    const src = utts[0].speaker_id
    if (src == null) return
    setPicking(null)
    try {
      const res = await api.post<Speaker | { speaker?: Speaker; id?: number }>(`/speakers/${src}/split`, { utterance_ids: utts.map((u) => u.id) })
      const sp = ('speaker' in res && res.speaker) ? res.speaker : (res as Speaker)
      emitUtteranceChange({ type: 'reassign', ids: utts.map((u) => u.id), speakerId: sp.id })
      refresh()
      setSplitDone({ speaker: sp, n: utts.length })
      pendingDone.current?.()
      pendingDone.current = undefined
    } catch (e) { toast.error(e) }
  }, [refresh, toast])

  const ops = useMemo<Ops>(() => ({
    reassign: (utts, onDone) => { if (utts.length) { pendingDone.current = onDone; setPicking({ utts, onDone }) } },
    split: (utts, onDone) => { if (utts.length) { pendingDone.current = onDone; void doSplit(utts) } },
    editText: (u) => { setEditing(u); setEditText(u.text) },
    remove: (utts, onDone) => setDeleting({ utts, onDone }),
    createTodo: (u) => setTodoFrom(u),
  }), [doSplit])

  const saveText = async () => {
    if (!editing) return
    const text = editText.trim()
    if (!text || text === editing.text) { setEditing(null); return }
    try {
      const res = await api.patch<Utterance>(`/utterances/${editing.id}`, { text })
      emitUtteranceChange({ type: 'patch', utterance: res })
      refresh()
      setEditing(null)
    } catch (e) { toast.error(e) }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    const ok: number[] = []
    for (const u of deleting.utts) {
      try { await api.del(`/utterances/${u.id}`); ok.push(u.id) } catch (e) { toast.error(e); break }
    }
    if (ok.length) { emitUtteranceChange({ type: 'delete', ids: ok }); refresh() }
    deleting.onDone?.()
    setDeleting(null)
  }

  const sameSource = picking && picking.utts.every((u) => u.speaker_id != null && u.speaker_id === picking.utts[0].speaker_id)
  const draft: TodoDraft | undefined = todoFrom ? {
    text: todoFrom.text, source_utterance_id: todoFrom.id, source_excerpt: todoFrom.text,
    assignee_speaker_id: todoFrom.speaker_id,
  } : undefined

  return (
    <Ctx.Provider value={ops}>
      {children}
      <Dialog
        open={!!picking}
        onClose={() => setPicking(null)}
        title={picking && picking.utts.length > 1 ? t('speakers.reassign_n', { n: picking.utts.length }) : t('speakers.reassign_title')}
        size="sm"
        fullOnMobile
      >
        {picking && (
          <SpeakerPickerList
            selectedId={picking.utts.length === 1 ? picking.utts[0].speaker_id : undefined}
            exclude={sameSource ? [picking.utts[0].speaker_id!] : undefined}
            maxHeight="max-h-[50vh]"
            top={sameSource ? (
              <button type="button" onClick={() => void doSplit(picking.utts)} className="flex min-h-[44px] w-full items-center gap-2.5 border-b border-line bg-accent-soft/50 px-3 py-2 text-left text-sm font-medium text-accent hover:bg-accent-soft">
                <Plus className="h-4 w-4" aria-hidden />
                {t('speakers.reassign_split_top')}
              </button>
            ) : undefined}
            onSelect={(s) => void doReassign(picking.utts, s.id)}
          />
        )}
      </Dialog>
      <Dialog
        open={!!progress}
        onClose={() => { if (progress && progress.done >= progress.total) setProgress(null) }}
        dismissable={!!progress && progress.done >= progress.total}
        title={t('speakers.reassign_title')}
        size="sm"
        footer={progress && progress.done >= progress.total && progress.failed.length > 0 ? (
          <>
            <Button onClick={() => { setProgress(null); refresh() }}>{t('common.close')}</Button>
            <Button variant="primary" onClick={() => {
              const p = progress
              void (async () => {
                const { okIds, failed } = await runReassign(p.failed, p.target)
                finishReassign(p.failed, p.target, okIds, failed)
              })()
            }}>{t('speakers.reassign_retry')}</Button>
          </>
        ) : undefined}
      >
        {progress && (
          <div className="space-y-3" aria-live="polite">
            <p className="text-sm">{t('speakers.reassign_progress', { done: progress.done, total: progress.total })}</p>
            <ProgressBar value={progress.done} max={progress.total} tone={progress.failed.length ? 'warn' : 'accent'} label={t('speakers.reassign_title')} />
            {progress.failed.length > 0 && <p className="text-sm text-danger">{t('speakers.reassign_failed', { n: progress.failed.length })}</p>}
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!splitDone}
        onClose={() => setSplitDone(null)}
        title={t('speakers.split')}
        size="sm"
        footer={splitDone && (
          <>
            <Button onClick={() => setSplitDone(null)}>{t('speakers.split_continue')}</Button>
            <Button variant="primary" onClick={() => { const id = splitDone.speaker.id; setSplitDone(null); navigate(`/speakers/${id}`) }}>{t('speakers.split_go_name')}</Button>
          </>
        )}
      >
        {splitDone && (
          <div className="flex items-start gap-2 text-sm">
            <SpeakerDot color={map.get(splitDone.speaker.id)?.color ?? (splitDone.speaker as Speaker).color} className="mt-1.5" dashed />
            <p>{t('speakers.split_done', { name: label(splitDone.speaker.id, (splitDone.speaker as Speaker).display_name), n: splitDone.n })}</p>
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={t('utt.edit_title')}
        size="md"
        footer={<><Button onClick={() => setEditing(null)}>{t('common.cancel')}</Button><Button variant="primary" disabled={!editText.trim()} onClick={() => void saveText()}>{t('common.save')}</Button></>}
      >
        <Textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={4} data-autofocus aria-label={t('utt.edit_title')} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveText() }} />
        <p className="mt-2 text-xs text-muted">{t('utt.edit_hint')}</p>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        danger
        title={deleting && deleting.utts.length > 1 ? t('utt.delete_n_title', { n: deleting.utts.length }) : t('utt.delete_title')}
        body={t('utt.delete_body')}
        confirmLabel={t('common.delete')}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
      <TodoDialog open={!!todoFrom} onClose={() => setTodoFrom(null)} draft={draft} title={t('todos.dialog_from_utterance')} />
    </Ctx.Provider>
  )
}
