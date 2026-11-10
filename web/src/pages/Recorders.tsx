import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, ChevronDown, KeyRound, Mic, MoreHorizontal, Pencil, Plus, Trash2, X, Check } from 'lucide-react'
import { Page } from '../components/Page'
import { Button, IconButton } from '../components/ui/Button'
import { Badge, EmptyState, ErrorBar, Skeleton, StatusDot, SectionTitle } from '../components/ui/Misc'
import { Input, Select, Switch } from '../components/ui/Form'
import { Menu } from '../components/ui/Popover'
import { ConfirmDialog } from '../components/ui/Confirm'
import { useToast } from '../components/ui/Toast'
import { RoomAddForm } from '../components/recorders/RoomAddForm'
import { VolumeBar } from '../components/recorders/VolumeBar'
import { RecorderConfigForm } from '../components/recorders/RecorderConfigForm'
import { AddRecorderDialog, DeleteRecorderDialog, RenameRecorderDialog, RotateTokenDialogs } from '../components/recorders/RecorderDialogs'
import { useFmt, useRecorders, useRooms, useSystemInfo } from '../hooks/useData'
import { useNow } from '../hooks/useNow'
import { usePatchRecorder, useRoomActions } from '../hooks/useRecorderActions'
import { ApiError } from '../lib/api'
import { bufferTone, versionMismatch } from '../lib/recorderConfig'
import type { Recorder, Room } from '../lib/types'
import { cn } from '../lib/cn'
import { useT } from '../i18n'

function RecorderCard({ r, rooms, coreVersion, onRename, onRotate, onDelete }: {
  r: Recorder; rooms: Room[]; coreVersion?: string; onRename: () => void; onRotate: () => void; onDelete: () => void
}) {
  const t = useT()
  const fmt = useFmt()
  const toast = useToast()
  const now = useNow(15_000)
  const patch = usePatchRecorder()
  const [open, setOpen] = useState(false)
  const [confirmPause, setConfirmPause] = useState(false)
  const enabled = r.config.enabled
  const state = r.status.state
  const tone = !r.online ? 'neutral' : !enabled ? 'warn' : state === 'error' ? 'danger' : 'ok'
  const stateText = !r.online ? t('status.recorder_offline') : !enabled ? t('rec.paused_manual') : state === 'error' ? t('status.recorder_state_error') : state === 'starting' ? t('status.recorder_state_starting') : t('rec.recording_on')
  const buf = r.status.buffered_chunks ?? 0
  const bt = bufferTone(buf)
  const mismatch = versionMismatch(r.version, coreVersion)
  const roomName = rooms.find((x) => x.id === r.room_id)?.name
  const activeDev = r.devices.find((d) => d.id === r.status.active_device)?.name ?? r.status.active_device
  const panelId = `rec-params-${r.id}`

  const setEnabled = async (v: boolean) => {
    try { await patch.mutateAsync({ id: r.id, body: { config: { enabled: v } } }) } catch (e) { toast.error(e) }
  }

  return (
    <article className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5" aria-label={r.name} data-testid={`recorder-${r.id}`}>
      <header className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted"><Mic className="h-[18px] w-[18px]" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-[15px] font-semibold">{r.name}</h3>
            {roomName && <span className="text-xs text-muted">{roomName}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={tone} pulse={tone === 'danger'} />
              <span className={cn(tone === 'ok' && 'text-fg', tone === 'danger' && 'text-danger')}>{stateText}</span>
            </span>
            <span title={r.last_seen ? fmt.full(r.last_seen) : undefined}>
              {r.last_seen ? t('rec.last_seen', { t: fmt.relative(r.last_seen, now) }) : t('rec.never_seen')}
            </span>
            {r.version && (
              mismatch
                ? <Badge tone="warn" title={t('rec.version_mismatch_hint', { r: r.version, c: coreVersion ?? '' })}><AlertTriangle className="mr-1 inline h-3 w-3" />{t('rec.version_mismatch')} · {r.version}</Badge>
                : <span>{t('rec.version', { v: r.version })}</span>
            )}
          </div>
        </div>
        <Menu
          label={t('rec.menu')}
          trigger={<IconButton aria-label={t('rec.menu')}><MoreHorizontal className="h-4 w-4" /></IconButton>}
          items={[
            { label: t('rec.rename'), icon: <Pencil className="h-4 w-4" />, onSelect: onRename },
            { label: t('rec.rotate'), icon: <KeyRound className="h-4 w-4" />, onSelect: onRotate },
            { label: t('rec.delete'), icon: <Trash2 className="h-4 w-4" />, onSelect: onDelete, danger: true, divider: true },
          ]}
        />
      </header>

      {state === 'error' && r.status.error && r.online && (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">{t('rec.state_error', { e: r.status.error })}</p>
      )}
      {mismatch && <p className="mt-3 text-xs text-muted">{t('rec.version_mismatch_hint', { r: r.version ?? '', c: coreVersion ?? '' })}</p>}

      <div className="mt-4 space-y-4">
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">{t('rec.volume')}</p>
          <VolumeBar db={r.status.level_db} offline={!r.online} />
          <p className="mt-1 text-[11px] text-faint">{r.online ? t('rec.volume_refresh') : t('rec.volume_offline')}</p>
        </div>
        <dl className="space-y-1.5 text-[13px]">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">{t('rec.recording_switch')}</dt>
            <dd>
              <Switch
                checked={enabled}
                label={t('rec.recording_switch')}
                disabled={patch.isPending}
                onChange={(v) => (v ? void setEnabled(true) : setConfirmPause(true))}
              />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">{t('rec.room')}</dt>
            <dd className="min-w-0">
              <Select
                aria-label={t('rec.room')}
                className="!h-8 !py-0 text-[13px]"
                value={r.room_id ?? ''}
                onChange={(e) => patch.mutate({ id: r.id, body: { room_id: e.target.value === '' ? null : Number(e.target.value) } }, { onError: (err) => toast.error(err) })}
              >
                <option value="">{t('rec.room_none')}</option>
                {rooms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">{t('rec.buffer', { n: buf })}</dt>
            <dd className="min-w-0 text-right">
              {bt !== 'ok' && <Badge tone={bt}>{bt === 'warn' ? t('rec.buffer_warn') : t('rec.buffer_bad')}</Badge>}
            </dd>
          </div>
          {activeDev && r.online && <p className="truncate text-xs text-muted" title={activeDev}>{t('rec.device', { d: activeDev })}</p>}
        </dl>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md py-1 text-left text-[13px] font-medium hover:text-accent"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          {t('rec.params')}
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
        </button>
        {open && <div id={panelId} className="mt-3"><RecorderConfigForm recorder={r} /></div>}
      </div>

      <ConfirmDialog
        open={confirmPause}
        title={t('rec.pause_title')}
        body={t('rec.pause_body')}
        confirmLabel={t('rec.pause_confirm')}
        busy={patch.isPending}
        onClose={() => setConfirmPause(false)}
        onConfirm={async () => { await setEnabled(false); setConfirmPause(false) }}
      />
    </article>
  )
}

function RoomRow({ room, count, rooms }: { room: Room; count: number; rooms: Room[] }) {
  const t = useT()
  const toast = useToast()
  const actions = useRoomActions()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(room.name)
  const [err, setErr] = useState<string | null>(null)
  const [del, setDel] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) input.current?.select() }, [editing])

  const save = async () => {
    const v = name.trim()
    if (!v) { setErr(t('rec.room_required')); return }
    if (v === room.name) { setEditing(false); return }
    if (rooms.some((x) => x.id !== room.id && x.name === v)) { setErr(t('rec.room_dup')); return }
    try { await actions.rename.mutateAsync({ id: room.id, name: v }); setEditing(false) } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErr(t('rec.room_dup')); else toast.error(e)
    }
  }

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      {editing ? (
        <form className="flex min-w-0 flex-1 items-start gap-2" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <div className="min-w-0 flex-1">
            <Input
              ref={input}
              aria-label={t('rec.room_rename')}
              value={name}
              invalid={!!err}
              maxLength={40}
              autoFocus
              onChange={(e) => { setName(e.target.value); setErr(null) }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false); setName(room.name); setErr(null) } }}
            />
            {err && <p className="mt-1 text-xs text-danger" role="alert">{err}</p>}
          </div>
          <IconButton aria-label={t('common.save')} type="submit"><Check className="h-4 w-4" /></IconButton>
          <IconButton aria-label={t('common.cancel')} onClick={() => { setEditing(false); setName(room.name); setErr(null) }}><X className="h-4 w-4" /></IconButton>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{room.name}</span>
          <span className="shrink-0 text-xs text-muted">{t('rec.room_recorders', { n: count })}</span>
          <IconButton aria-label={t('rec.room_rename')} onClick={() => { setName(room.name); setEditing(true) }}><Pencil className="h-4 w-4" /></IconButton>
          <IconButton aria-label={t('rec.room_delete')} onClick={() => setDel(true)}><Trash2 className="h-4 w-4" /></IconButton>
        </>
      )}
      <ConfirmDialog
        open={del}
        danger
        title={t('rec.room_delete_title', { name: room.name })}
        body={count > 0 ? t('rec.room_delete_body', { n: count }) : undefined}
        confirmLabel={t('common.delete')}
        busy={actions.remove.isPending}
        onClose={() => setDel(false)}
        onConfirm={async () => {
          try { await actions.remove.mutateAsync(room.id); toast.success(t('rec.room_deleted')); setDel(false) } catch (e) { toast.error(e) }
        }}
      />
    </li>
  )
}

export default function Recorders() {
  const t = useT()
  const recs = useRecorders(5000)
  const rooms = useRooms()
  const sys = useSystemInfo()
  const [params, setParams] = useSearchParams()
  const [addOpen, setAddOpen] = useState(params.get('add') === '1')
  const [renaming, setRenaming] = useState<Recorder | null>(null)
  const [rotating, setRotating] = useState<Recorder | null>(null)
  const [deleting, setDeleting] = useState<Recorder | null>(null)
  const roomList = rooms.data ?? []
  const counts = useMemo(() => {
    const m = new Map<number, number>()
    for (const r of recs.data ?? []) if (r.room_id != null) m.set(r.room_id, (m.get(r.room_id) ?? 0) + 1)
    return m
  }, [recs.data])

  useEffect(() => {
    if (params.get('add') === '1') { setAddOpen(true); const p = new URLSearchParams(params); p.delete('add'); setParams(p, { replace: true }) }
  }, [params, setParams])

  return (
    <Page
      title={t('rec.title')}
      actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAddOpen(true)}>{t('rec.add')}</Button>}
    >
      <section aria-labelledby="rec-h" className="space-y-3">
        <SectionTitle><span id="rec-h">{t('rec.section_recorders')}</span></SectionTitle>
        {recs.isError && <ErrorBar message={t('rec.load_failed')} onRetry={() => void recs.refetch()} retryLabel={t('common.retry')} />}
        {recs.isLoading && (
          <div className="grid gap-4 lg:grid-cols-2">
            {[0, 1].map((i) => <Skeleton key={i} className="h-56 rounded-xl" />)}
          </div>
        )}
        {recs.data && recs.data.length === 0 && (
          <EmptyState
            icon={<Mic className="h-6 w-6" />}
            title={t('rec.empty')}
            body={t('rec.empty_body')}
            action={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAddOpen(true)}>{t('rec.add')}</Button>}
          />
        )}
        {recs.data && recs.data.length > 0 && (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {recs.data.map((r) => (
              <RecorderCard key={r.id} r={r} rooms={roomList} coreVersion={sys.data?.version} onRename={() => setRenaming(r)} onRotate={() => setRotating(r)} onDelete={() => setDeleting(r)} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="room-h" className="mt-8 space-y-3">
        <SectionTitle><span id="room-h">{t('rec.section_rooms')}</span></SectionTitle>
        {rooms.isError && <ErrorBar message={t('rec.load_failed')} onRetry={() => void rooms.refetch()} retryLabel={t('common.retry')} />}
        {rooms.data && rooms.data.length === 0 && <p className="text-[13px] text-muted">{t('rec.rooms_empty_body')}</p>}
        {roomList.length > 0 && (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-card">
            {roomList.map((rm) => <RoomRow key={rm.id} room={rm} rooms={roomList} count={counts.get(rm.id) ?? 0} />)}
          </ul>
        )}
        {rooms.data && <RoomAddForm rooms={roomList} />}
      </section>

      <AddRecorderDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <RenameRecorderDialog recorder={renaming} onClose={() => setRenaming(null)} />
      <RotateTokenDialogs recorder={rotating} onClose={() => setRotating(null)} />
      <DeleteRecorderDialog recorder={deleting} onClose={() => setDeleting(null)} />
    </Page>
  )
}
