import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { usePlayer } from '../player/PlayerProvider'

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

const PLAYBACK_RATES = [1, 1.25, 1.5, 2]

export default function PlayerPage() {
  const { itemId } = useParams<{ itemId: string }>()
  const { state, rate, play, pause, resume, seek, close, setRate, jumpForward, jumpBackward, setSleepTimer } = usePlayer()

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

  if (!itemId) return null

  return (
    <div className="player-page">
      <p className="player-status">{state.status === 'loading' ? 'Loading…' : state.status}</p>
      <input
        type="range"
        aria-label="Seek"
        min={0}
        max={state.duration || 0}
        value={Math.min(state.currentTime, state.duration || 0)}
        onChange={(event) => seek(Number(event.target.value))}
        disabled={state.status === 'loading' || state.status === 'idle'}
      />
      <p className="player-time">
        {formatTime(state.currentTime)} / {formatTime(state.duration)}
      </p>
      <div className="player-controls">
        <button type="button" onClick={() => jumpBackward()} aria-label="Jump backward">
          -10s
        </button>
        {state.status === 'playing' ? (
          <button type="button" onClick={pause}>
            Pause
          </button>
        ) : (
          <button type="button" onClick={() => void resume()} disabled={state.status === 'loading' || state.status === 'idle'}>
            Play
          </button>
        )}
        <button type="button" onClick={() => jumpForward()} aria-label="Jump forward">
          +30s
        </button>
        <button
          type="button"
          onClick={() => {
            const currentIndex = PLAYBACK_RATES.indexOf(rate)
            const next = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length]
            setRate(next)
          }}
        >
          {rate}x
        </button>
      </div>
      <div className="player-sleep-timer">
        <button type="button" onClick={() => setSleepTimer(30 * 60)}>
          Sleep 30m
        </button>
        <button type="button" onClick={() => setSleepTimer(null)}>
          Cancel sleep
        </button>
      </div>
      {state.error && <p role="alert">{state.error}</p>}
    </div>
  )
}
