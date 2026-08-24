import { App as CapacitorApp } from '@capacitor/app'
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { HtmlAudioPlayer } from './htmlAudioPlayer'
import { INITIAL_PLAYER_STATE, PlayerState } from './playerTypes'

export interface PlayerContextValue {
  state: PlayerState
  play: (itemId: string) => Promise<void>
  pause: () => void
  resume: () => Promise<void>
  seek: (time: number) => void
  close: () => Promise<void>
}

export const PlayerContext = createContext<PlayerContextValue | null>(null)

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { client } = useAuth()
  const player = useMemo(() => new HtmlAudioPlayer({ api: client }), [client])
  const [state, setState] = useState<PlayerState>(INITIAL_PLAYER_STATE)

  useEffect(() => player.subscribe(setState), [player])

  useEffect(() => {
    // Close (not just pause) on app background per the vertical-slice spec -- the sync
    // timer cannot run while backgrounded, so we report final progress immediately instead.
    const listenerHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) void player.close()
    })
    return () => {
      void listenerHandle.then((handle) => handle.remove())
    }
  }, [player])

  const value = useMemo<PlayerContextValue>(
    () => ({
      state,
      play: (itemId: string) => player.play(itemId),
      pause: () => player.pause(),
      resume: () => player.resume(),
      seek: (time: number) => player.seek(time),
      close: () => player.close()
    }),
    [state, player]
  )

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}

export function usePlayer(): PlayerContextValue {
  const value = useContext(PlayerContext)
  if (!value) {
    throw new Error('usePlayer must be used within a PlayerProvider')
  }
  return value
}
