'use client'

import LoadingSpinner from '@/components/widgets/LoadingSpinner'
import { useAcquisition } from '@/contexts/AcquisitionContext'
import { useTypeSafeTranslations } from '@/hooks/useTypeSafeTranslations'

function StatusRow({ label, healthy, cyId }: { label: string; healthy: boolean; cyId: string }) {
  const t = useTypeSafeTranslations()
  return (
    <div className="border-border/50 flex items-center justify-between border-b py-2 last:border-b-0" cy-id={cyId}>
      <span>{label}</span>
      <span className={healthy ? 'text-success' : 'text-error'}>{healthy ? t('LabelConnected') : t('LabelOffline')}</span>
    </div>
  )
}

/** Secret-free acquisition gateway diagnostics. Reads exclusively from AcquisitionContext's
 * status (loaded once on mount by AcquisitionProvider) -- never opens a second fetch path and
 * never renders an editable credential/token control. */
export default function AcquisitionSettingsClient() {
  const t = useTypeSafeTranslations()
  const { status } = useAcquisition()

  if (!status) {
    return (
      <div className="flex items-center justify-center py-10">
        <LoadingSpinner size="la-lg" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col" cy-id="acquisition-status-rows">
        <StatusRow label={t('LabelGateway')} healthy={status.ready} cyId="acquisition-status-gateway" />
        <StatusRow label={t('LabelLibrarr')} healthy={status.librarr.reachable} cyId="acquisition-status-librarr" />
        <StatusRow label={t('LabelStaging')} healthy={status.staging.ready} cyId="acquisition-status-staging" />
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground-muted">{t('LabelVersion')}</span>
        <span>{status.version}</span>
      </div>

      <div>
        <h2 className="text-foreground-muted mb-2 text-sm">{t('LabelEnabledLibraries')}</h2>
        {status.libraries.length === 0 ? (
          <p className="text-foreground-muted text-sm">{t('LabelNone')}</p>
        ) : (
          <div className="flex flex-wrap gap-2" cy-id="acquisition-enabled-libraries">
            {status.libraries.map((library) => (
              <span key={library.id} className="bg-primary/50 rounded-md px-2 py-0.5 text-xs">
                {library.id}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
