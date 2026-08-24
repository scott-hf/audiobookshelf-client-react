import SettingsContent from '../SettingsContent'
import { getTypeSafeTranslations } from '@/lib/getTypeSafeTranslations'
import AcquisitionSettingsClient from './AcquisitionSettingsClient'

export const dynamic = 'force-dynamic'

export default async function AcquisitionSettingsPage() {
  const t = await getTypeSafeTranslations()

  return (
    <SettingsContent title={t('HeaderAcquisition')}>
      <AcquisitionSettingsClient />
    </SettingsContent>
  )
}
