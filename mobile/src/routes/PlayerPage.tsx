import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTypeSafeTranslations } from '@/hooks/useTypeSafeTranslations'
import { mergeClasses } from '@/lib/merge-classes'
import { useAuth } from '../auth/AuthProvider'
import BookCover from '../components/BookCover'
import type { PlayerStatus } from '../player/playerTypes'
import { useDownloads } from '../downloads/DownloadProvider'
import { localCoverSrc, parseLocalManifest } from '../player/offlineSource'
import { usePlayer } from '../player/PlayerProvider'
import type { TranslationKey } from '../types/translations'
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

/** Sleep timer durations, in minutes. The native side (`SleepTimerManager.start`) takes arbitrary
 * seconds, so this list is purely what the UI offers -- it was previously a single hardcoded 30,
 * which left no way to ask for anything else. Matches the set the Audiobookshelf web player
 * offers, so the two do not disagree about what a sleep timer can be. */
const SLEEP_TIMER_MINUTES = [5, 10, 15, 30, 45, 60, 90]

/** Matches PlayerProvider's DEFAULT_JUMP_* constants -- the jump buttons call jumpBackward()/
 * jumpForward() with no argument, so these are labels for the provider's defaults, not a
 * separate source of truth. (The configurable values in Settings are not yet wired through to
 * the player; changing that is a behavior change, not a styling one.) */
const JUMP_BACK_SECONDS = 10
const JUMP_FORWARD_SECONDS = 30

const STATUS_LABEL_KEYS: Record<PlayerStatus, TranslationKey> = {
  idle: 'MessagePlayerStatusIdle',
  loading: 'MessagePlayerStatusLoading',
  buffering: 'MessagePlayerStatusBuffering',
  playing: 'MessagePlayerStatusPlaying',
  paused: 'MessagePlayerStatusPaused',
  ended: 'MessagePlayerStatusEnded',
  error: 'MessagePlayerStatusError'
}

export default function PlayerPage() {
  const { itemId } = useParams<{ itemId: string }>()
  const { client } = useAuth()
  const t = useTypeSafeTranslations()
  const { state, stalled, rate, play, pause, resume, seek, setRate, jumpForward, jumpBackward, setSleepTimer } = usePlayer()
  const { localItems } = useDownloads()
  const [item, setItem] = useState<AbsLibraryItem | null>(null)
  // `null` = no timer running. The native side is the clock; this is only what the user picked,
  // so the label can name it. There is no remaining-time feed from the player yet, which is why
  // the button shows the chosen duration rather than a countdown.
  const [sleepMinutes, setSleepMinutes] = useState<number | null>(null)
  const [sleepPickerOpen, setSleepPickerOpen] = useState(false)

  useEffect(() => {
    if (itemId && state.itemId !== itemId) {
      // A failed start is already reflected in `state` (status 'error' + message) with a retry
      // button, so the rejection itself carries nothing more to show.
      play(itemId).catch(() => {})
    }
    // Deliberately NO unmount cleanup. This page is only mounted on the `/play` routes, so any
    // tab tap (Downloads, Library, Settings) unmounts it -- and a `close()` here stopped playback
    // outright, which is what the user hit by tapping Downloads mid-book. Audio is owned by the
    // native foreground service, not by this page, and must outlive it; progress keeps being
    // reported by the provider's sync timer, which also keeps running.
    //
    // Item replacement does not need this either: `play()` tears the previous item down itself via
    // `teardownNative({ keepForeground: true })`. Stopping for real is the pause button, or
    // dismissing the player notification.
    //
    // Only re-run when the target item changes, not on every player state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  // Cover/title are presentation only -- the offline route (/downloads/:itemId/play) may have no
  // reachable server, so a failed lookup silently degrades to the downloaded manifest's metadata
  // (or the id-less fallback cover when the book is not downloaded).
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

  // `buffering` is deliberately NOT disabled: the user must still be able to pause (or seek away
  // from) a stalled buffer.
  const controlsDisabled = state.status === 'loading' || state.status === 'idle'
  // The button reflects intent: buffering while playWhenReady will start playing by itself, so it
  // shows Pause -- a tap pauses instead of calling play() on an already-playing-intent player.
  const showPause = state.status === 'playing' || (state.status === 'buffering' && state.playWhenReady)
  const showSpinner = state.status === 'buffering' || state.status === 'loading'
  const showRetry = state.status === 'error'
  const statusLabel = stalled && state.status === 'buffering' ? t('MessagePlayerStalled') : t(STATUS_LABEL_KEYS[state.status])
  const duration = state.duration || 0
  const progressPercent = duration > 0 ? (Math.min(state.currentTime, duration) / duration) * 100 : 0
  // The live server item wins when reachable; otherwise a downloaded book falls back to the
  // metadata and cover its manifest captured at download time.
  const offline = parseLocalManifest(localItems.find((entry) => entry.libraryItemId === itemId))
  const title = item?.media.metadata.title ?? offline?.title
  const authorName = item?.media.metadata.authorName ?? offline?.author
  const coverUrl = item ? client.authorizedStreamUrl(`/api/items/${encodeURIComponent(itemId)}/cover`) : localCoverSrc(offline?.coverPath)

  const chooseSleepTimer = (minutes: number | null) => {
    setSleepMinutes(minutes)
    setSleepTimer(minutes === null ? null : minutes * 60)
    setSleepPickerOpen(false)
  }

  return (
    // Layout contract (see PlayerPage.test.tsx "layout"): the root fills the app shell's scroll area
    // (`h-full`) and splits it into a shrinkable info region (`data-testid="player-info"`, scrolls
    // on its own) and a `shrink-0` controls dock that is NOT inside any overflow container. The
    // transport controls are therefore on screen at first paint at any height that fits the dock;
    // only below `min-h-[15rem]` does the shell's own scroll area take over, so nothing is clipped.
    // The shell (App.tsx) already keeps this area above AppTabBar and the safe-area insets.
    //
    // `short:` (see theme/index.css) turns that single column into two side by side. Stacking
    // cover, title and dock needs more height than a phone in landscape has: measured on device,
    // the speed/sleep row sat behind the tab bar until you scrolled 161px, and the cover was
    // squeezed to a ~100px sliver. Side by side halves the height the stack needs, so the whole
    // dock fits without scrolling and the cover gets the full column height instead.
    <div className="flex h-full min-h-[15rem] flex-col items-center short:min-h-0 short:flex-row short:items-stretch short:gap-4">
      <div data-testid="player-info" className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto overscroll-contain short:w-1/2 short:justify-center">
        {/* Height is capped by the viewport, not the width: the old `w-full max-w-xs` + 2:3 aspect
            made a 480px-tall cover that alone pushed Pause off-screen. `w-auto` on the cover lets
            the aspect ratio derive the width from this height. Side by side there is no dock below
            it, so the cover simply takes what is left of the column. */}
        <div className="flex h-[min(40dvh,18rem)] w-full shrink-0 justify-center pt-1 short:h-auto short:min-h-0 short:flex-1 short:shrink">
          <BookCover title={title ?? 'Now playing'} authorName={authorName} coverUrl={coverUrl} className="h-full w-auto" />
        </div>

        <div className="mt-4 w-full max-w-sm shrink-0 text-center short:mt-2">
          {title && <h2 className="text-foreground text-lg leading-tight font-bold">{title}</h2>}
          {authorName && <p className="text-foreground-muted mt-0.5 text-sm">{authorName}</p>}
        </div>
      </div>

      <div data-testid="player-controls" className="mt-3 w-full max-w-sm shrink-0 short:mt-0 short:w-1/2 short:self-center">
        <p className="text-foreground-subdued mb-1 text-center text-xs" aria-live="polite">
          {statusLabel}
        </p>
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

        <div className="mt-3 flex w-full items-center justify-center gap-6">
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

          <button
            type="button"
            onClick={() => {
              if (showRetry) play(itemId).catch(() => {})
              else if (showPause) pause()
              else void resume()
            }}
            disabled={controlsDisabled}
            aria-label={showRetry ? t('ButtonRetry') : showPause ? t('ButtonPause') : t('ButtonPlay')}
            className="bg-accent text-black-600 disabled:bg-bg-disabled disabled:text-disabled relative flex size-16 items-center justify-center rounded-full shadow-lg transition-transform active:scale-95 disabled:active:scale-100"
          >
            {showSpinner && (
              <span
                data-testid="player-spinner"
                className="border-accent/30 border-t-accent pointer-events-none absolute -inset-1.5 animate-spin rounded-full border-2"
                aria-hidden="true"
              />
            )}
            <span className="material-symbols fill text-4xl" aria-hidden="true">
              {showRetry ? 'refresh' : showPause ? 'pause' : 'play_arrow'}
            </span>
          </button>

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

        <div className="mt-3 flex w-full items-center justify-center gap-3">
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
            onClick={() => setSleepPickerOpen((open) => !open)}
            aria-pressed={sleepMinutes !== null}
            aria-expanded={sleepPickerOpen}
            aria-label={sleepMinutes === null ? 'Set a sleep timer' : `Sleep timer set to ${sleepMinutes} minutes`}
            className={mergeClasses(
              'flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors',
              sleepMinutes !== null ? 'bg-accent border-accent text-black-600' : 'bg-primary border-border text-foreground hover:bg-bg-hover'
            )}
          >
            <span className="material-symbols text-base" aria-hidden="true">
              bedtime
            </span>
            {sleepMinutes === null ? 'Sleep' : `Sleep ${sleepMinutes}m`}
          </button>
        </div>

        {sleepPickerOpen && (
          <div data-testid="sleep-timer-options" className="mt-2 flex w-full flex-wrap items-center justify-center gap-2">
            {SLEEP_TIMER_MINUTES.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => chooseSleepTimer(minutes)}
                aria-pressed={sleepMinutes === minutes}
                className={mergeClasses(
                  'rounded-md border px-2.5 py-1 text-sm font-semibold tabular-nums transition-colors',
                  sleepMinutes === minutes ? 'bg-accent border-accent text-black-600' : 'bg-primary border-border text-foreground hover:bg-bg-hover'
                )}
              >
                {minutes}m
              </button>
            ))}
            {sleepMinutes !== null && (
              <button
                type="button"
                onClick={() => chooseSleepTimer(null)}
                className="bg-primary border-border text-foreground hover:bg-bg-hover rounded-md border px-2.5 py-1 text-sm font-semibold transition-colors"
              >
                Off
              </button>
            )}
          </div>
        )}

        {state.error && (
          <p role="alert" className="text-error mt-3 text-center text-sm">
            {state.error}
          </p>
        )}
      </div>
    </div>
  )
}
