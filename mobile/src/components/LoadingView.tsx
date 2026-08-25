import LoadingIndicator from './ui/LoadingIndicator'

export default function LoadingView({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="relative flex min-h-40 w-full items-center justify-center">
      <LoadingIndicator variant="inline" label={label} />
    </div>
  )
}
