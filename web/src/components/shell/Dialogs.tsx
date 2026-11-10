import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { queryClient } from '../../lib/queryClient'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { Banner, Kbd } from '../ui/Misc'
import { Field, Input } from '../ui/Form'
import { SpeakerPickerList } from '../speakers/SpeakerPicker'
import { useMe } from '../../hooks/useData'
import { useToast } from '../ui/Toast'
import { useT } from '../../i18n'

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const goRows: [string, string][] = [
    ['d', t('shortcuts.go_dashboard')], ['t', t('shortcuts.go_timeline')], ['s', t('shortcuts.go_summaries')], ['o', t('shortcuts.go_todos')],
    ['p', t('shortcuts.go_speakers')], ['r', t('shortcuts.go_recorders')], ['c', t('shortcuts.go_settings')],
  ]
  const rows: [string[], string][] = [
    [['/'], t('shortcuts.search')], [['j', 'k'], t('shortcuts.next_prev')], [['x'], t('shortcuts.select')], [['e'], t('shortcuts.edit')],
    [['d'], t('shortcuts.todo_done')], [['Space'], t('shortcuts.play')], [['[', ']'], t('shortcuts.day_nav')], [['Esc'], t('shortcuts.escape')], [['?'], t('shortcuts.help')],
  ]
  return (
    <Dialog open={open} onClose={onClose} title={t('shortcuts.title')} description={t('shortcuts.hint')} size="md">
      <div className="space-y-4 text-sm">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('shortcuts.go')}</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            {goRows.map(([k, l]) => (
              <div key={k} className="flex items-center justify-between gap-2"><span>{l}</span><span className="flex gap-1"><Kbd>g</Kbd><Kbd>{k}</Kbd></span></div>
            ))}
          </div>
        </div>
        <div className="space-y-1.5 border-t border-line pt-3">
          {rows.map(([keys, l]) => (
            <div key={l} className="flex items-center justify-between gap-2"><span>{l}</span><span className="flex gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span></div>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

export function WhoAmIDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [me, setMe] = useMe()
  return (
    <Dialog open={open} onClose={onClose} title={t('me.title')} description={t('me.desc')} size="sm">
      <SpeakerPickerList
        namedOnly
        selectedId={me}
        noneLabel={t('me.none')}
        onNone={() => { setMe(null); onClose() }}
        onSelect={(s) => { setMe(s.id); onClose() }}
      />
    </Dialog>
  )
}

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const nav = useNavigate()
  const toast = useToast()
  const [oldPw, setOld] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => api.post('/auth/password', { old_password: oldPw, new_password: pw }) })

  const submit = async () => {
    if (pw.length < 6) return setErr(t('login.too_short'))
    if (pw !== pw2) return setErr(t('login.mismatch'))
    try {
      await m.mutateAsync()
      queryClient.clear()
      sessionStorage.setItem('murmur.flash', 'pw_changed')
      nav('/login', { replace: true })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setErr(t('pw.wrong_old'))
      else toast.error(e)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('pw.title')}
      size="sm"
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={m.isPending} onClick={() => void submit()} disabled={!oldPw || !pw}>{t('pw.submit')}</Button></>}
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <Field label={t('pw.old')}><Input type="password" autoComplete="current-password" value={oldPw} onChange={(e) => { setOld(e.target.value); setErr(null) }} /></Field>
        <Field label={t('pw.new')}><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(null) }} /></Field>
        <Field label={t('pw.confirm')} error={err}><Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => { setPw2(e.target.value); setErr(null) }} /></Field>
        <Banner tone="info">{t('pw.relogin')}</Banner>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  )
}
