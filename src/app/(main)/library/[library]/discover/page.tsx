import DiscoverClient from './DiscoverClient'

export default async function DiscoverPage({ params }: { params: Promise<{ library: string }> }) {
  const { library: libraryId } = await params

  return (
    <div className="w-full">
      <DiscoverClient libraryId={libraryId} />
    </div>
  )
}
