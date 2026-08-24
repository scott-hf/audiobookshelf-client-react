export interface AbsLibrary {
  id: string
  name: string
  mediaType: 'book' | 'podcast'
}

export interface GetLibrariesResponse {
  libraries: AbsLibrary[]
}

export interface AbsMediaProgress {
  currentTime: number
  duration: number
  isFinished: boolean
  progress: number
}

export interface AbsLibraryItemMedia {
  metadata: {
    title: string
    authorName?: string | null
    description?: string | null
  }
  coverPath?: string | null
  duration?: number | null
}

export interface AbsLibraryItem {
  id: string
  libraryId: string
  media: AbsLibraryItemMedia
  userMediaProgress?: AbsMediaProgress | null
}

export interface GetLibraryItemsResponse {
  results: AbsLibraryItem[]
  total: number
}

export interface AbsAudioTrack {
  index: number
  contentUrl: string
  duration: number
}

export interface AbsPlaybackSession {
  id: string
  currentTime: number
  audioTracks: AbsAudioTrack[]
}
