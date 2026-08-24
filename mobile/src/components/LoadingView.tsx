export default function LoadingView({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="loading-view">
      {label}
    </p>
  )
}
