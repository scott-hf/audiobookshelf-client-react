import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import BookCover from '../components/BookCover'
import { mergeClasses } from '@/lib/merge-classes'
import { usePlayer } from '../player/PlayerProvider'
import type { AbsLibraryItem } from '../types/abs'

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

const PLAYBACK_RATES = [1, 1.25, 1.5, 2]

/** Matches PlayerProvider's DEFAULT_JUMP_* constants -- the jump buttons call jumpBackward()/
 * jumpForward() with no argument, so these are labels for the provider's defaults, not a
 * separate source of truth. (The configurable values in Settings are not yet wired through to
 * the player; changing that is a behavior change, not a styling one.) */
const JUMP_BACK_SECONDS = 10
const JUMP_FORWARD_SECONDS = 30

const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  loading: 'Loading…',
  buffering: 'Buffering…',
  playing: 'Playing',
  paused: 'Paused',
  ended: 'Finished',
  error: 'Error'
}

export default function PlayerPage() {
  const { itemId } = useParams<{ itemId: string }>()
  const { client } = useAuth()
  const { state, rate, play, pause, resume, seek, close, setRate, jumpForward, jumpBackward, setSleepTimer } = usePlayer()
  const [item, setItem] = useState<AbsLibraryItem | null>(null)
  const [sleepTimerOn, setSleepTimerOn] = useState(false)

  useEffect(() => {
    if (itemId && state.itemId !== itemId) {
      void play(itemId)
    }
    // Item replacement / unmount -- close reports final progress and stops the sync timer.
    return () => {
      void close()
    }
    // Only re-run when the target item changes, not on every player state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  // Cover/title are presentation only -- the offline route (/downloads/:itemId/play) may have no
  // reachable server, so a failed lookup silently degrades to the id-less fallback cover.
  useEffect(() => {
    if (!itemId) return
    let cancelled = false
    setItem(null)
    client
      .getLibraryItem(itemId)
      .then((result) => {
        if (!cancelled) setItem(result)
      })
      .catch(() => {
        /* offline or unreachable -- fallback cover is rendered instead */
      })
    return () => {
      cancelled = true
    }
  }, [client, itemId])

  if (!itemId) return null

  const controlsDisabled = state.status === 'loading' || state.status === 'idle'
  const isPlaying = state.status === 'playing'
  const duration = state.duration || 0
  const progressPercent = duration > 0 ? (Math.min(state.currentTime, duration) / duration) * 100 : 0
  const title = item?.media.metadata.title
  const authorName = item?.media.metadata.authorName
  const coverUrl = item ? client.authorizedStreamUrl(`/api/items/${encodeURIComponent(itemId)}/cover`) : null

  const toggleSleepTimer = () => {
    const next = !sleepTimerOn
    setSleepTimerOn(next)
    setSleepTimer(next ? 30 * 60 : null)
  }

  return (
    <div className="flex min-h-full flex-col items-center">
      <div className="w-full max-w-xs pt-2">
        <BookCover title={title ?? 'Now playing'} authorName={authorName} coverUrl={coverUrl} />
      </div>

      <div className="mt-5 w-full max-w-sm text-center">
        {title && <h2 className="text-foreground text-lg leading-tight font-bold">{title}</h2>}
        {authorName && <p className="text-foreground-muted mt-0.5 text-sm">{authorName}</p>}
        <p className="text-foreground-subdued mt-1 text-xs" aria-live="polite">
          {STATUS_LABELS[state.status] ?? state.status}
        </p>
      </div>

      <div className="mt-5 w-full max-w-sm">
        <div className="relative">
          {/* Visual track sits behind the native range input, which is transparent and full-width */}
          <div className="bg-track-bg pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full">
            <div className="bg-accent h-full rounded-full" style={{ width: `${progressPercent}%` }} />
          </div>
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={duration}
            value={Math.min(state.currentTime, duration)}
            onChange={(event) => seek(Number(event.target.value))}
            disabled={controlsDisabled}
            className={mergeClasses(
              'relative w-full cursor-pointer appearance-none bg-transparent focus:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              '[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:bg-transparent',
              '[&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:h-4.5 [&::-webkit-slider-thumb]:w-4.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white',
              '[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:bg-transparent',
              '[&::-moz-range-thumb]:h-4.5 [&::-moz-range-thumb]:w-4.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:bg-white'
            )}
          />
        </div>
        <p className="text-foreground-subdued mt-1 flex justify-between text-xs tabular-nums">
          <span>{formatTime(state.currentTime)}</span>
          <span>{formatTime(state.duration)}</span>
        </p>
      </div>

      <div className="mt-6 flex w-full max-w-sm items-center justify-center gap-6">
        <button
          type="button"
          onClick={() => jumpBackward()}
          aria-label="Jump backward"
          className="text-foreground-muted hover:text-foreground relative flex flex-col items-center transition-colors"
        >
          <span className="material-symbols text-4xl" aria-hidden="true">
            replay
          </span>
          <span className="text-xxs absolute inset-0 flex items-center justify-center pt-1 font-semibold" aria-hidden="true">
            {JUMP_BACK_SECONDS}
          </span>
        </button>

        {isPlaying ? (
          <button
            type="button"
            onClick={pause}
            aria-label="Pause"
            className="bg-accent text-black-600 flex size-16 items-center justify-center rounded-full shadow-lg transition-transform active:scale-95"
          >
            <span className="material-symbols fill text-4xl" aria-hidden="true">
              pause
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void resume()}
            disabled={controlsDisabled}
            aria-label="Play"
            className="bg-accent text-black-600 disabled:bg-bg-disabled disabled:text-disabled flex size-16 items-center justify-center rounded-full shadow-lg transition-transform active:scale-95 disabled:active:scale-100"
          >
            <span className="material-symbols fill text-4xl" aria-hidden="true">
              play_arrow
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={() => jumpForward()}
          aria-label="Jump forward"
          className="text-foreground-muted hover:text-foreground relative flex flex-col items-center transition-colors"
        >
          <span className="material-symbols -scale-x-100 text-4xl" aria-hidden="true">
            replay
          </span>
          <span className="text-xxs absolute inset-0 flex items-center justify-center pt-1 font-semibold" aria-hidden="true">
            {JUMP_FORWARD_SECONDS}
          </span>
        </button>
      </div>

      <div className="mt-6 flex w-full max-w-sm items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => {
            const currentIndex = PLAYBACK_RATES.indexOf(rate)
            const next = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length]
            setRate(next)
          }}
          aria-label={`Playback speed ${rate}x`}
          className="bg-primary border-border text-foreground hover:bg-bg-hover flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-semibold tabular-nums transition-colors"
        >
          <span className="material-symbols text-base" aria-hidden="true">
            speed
          </span>
          {rate}x
        </button>

        <button
          type="button"
          onClick={toggleSleepTimer}
          aria-pressed={sleepTimerOn}
          className={mergeClasses(
            'flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors',
            sleepTimerOn ? 'bg-accent border-accent text-black-600' : 'bg-primary border-border text-foreground hover:bg-bg-hover'
          )}
        >
          <span className="material-symbols text-base" aria-hidden="true">
            bedtime
          </span>
          {sleepTimerOn ? 'Sleep 30m on' : 'Sleep 30m'}
        </button>
      </div>

      {state.error && (
        <p role="alert" className="text-error mt-5 text-center text-sm">
          {state.error}
        </p>
      )}
    </div>
  )
}
