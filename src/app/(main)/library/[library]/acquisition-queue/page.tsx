import AcquisitionQueueClient from './AcquisitionQueueClient'

export default async function AcquisitionQueuePage({ params }: { params: Promise<{ library: string }> }) {
  const { library: libraryId } = await params

  return (
    <div className="w-full">
      <AcquisitionQueueClient libraryId={libraryId} />
    </div>
  )
}
