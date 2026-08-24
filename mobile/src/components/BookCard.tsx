import type { AbsLibraryItem } from '../types/abs'

export default function BookCard({ item, onSelect }: { item: AbsLibraryItem; onSelect: (item: AbsLibraryItem) => void }) {
  const progress = item.userMediaProgress?.progress ?? 0
  return (
    <button type="button" className="book-card" onClick={() => onSelect(item)}>
      <div className="book-card-cover" aria-hidden="true" />
      <div className="book-card-info">
        <span className="book-card-title">{item.media.metadata.title}</span>
        {item.media.metadata.authorName && <span className="book-card-author">{item.media.metadata.authorName}</span>}
        {progress > 0 && (
          <div className="book-card-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="book-card-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
    </button>
  )
}
