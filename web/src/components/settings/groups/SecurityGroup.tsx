import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { KeyRound, LogOut } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Banner } from '../../ui/Misc'
import { Section } from '../Fields'
import { ChangePasswordDialog } from '../../shell/Dialogs'
import { api } from '../../../lib/api'
import { queryClient } from '../../../lib/queryClient'
import { useT } from '../../../i18n'

export default function SecurityGroup() {
  const t = useT()
  const nav = useNavigate()
  const [pw, setPw] = useState(false)
  const logout = async () => {
    try { await api.post('/auth/logout') } catch { /* already signed out */ }
    queryClient.clear()
    nav('/login', { replace: true })
  }
  return (
    <>
      <Section title={t('set.sec_password')} hint={t('set.sec_password_hint')}>
        <Banner tone="info">{t('pw.relogin')}</Banner>
        <Button icon={<KeyRound className="h-4 w-4" />} onClick={() => setPw(true)}>{t('pw.submit')}</Button>
      </Section>
      <Section title={t('set.sec_session')} hint={t('set.sec_session_hint')} className="mt-4">
        <Button icon={<LogOut className="h-4 w-4" />} onClick={() => void logout()}>{t('topbar.logout')}</Button>
      </Section>
      <p className="mt-4 text-xs leading-5 text-muted">{t('set.sec_reset_hint')}</p>
      <ChangePasswordDialog open={pw} onClose={() => setPw(false)} />
    </>
  )
}
