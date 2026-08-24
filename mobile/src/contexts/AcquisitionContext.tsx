import type { Acquisition } from '@abs/acquisition-contract'
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { AcquisitionStatusResponse } from '../api/acquisitionClient'
import { useAuth } from '../auth/AuthProvider'

const POLL_INTERVAL_MS = 10_000

export interface AcquisitionContextValue {
  status: AcquisitionStatusResponse | null
  isLibraryEnabled: (libraryId: string) => boolean
  getQueue: (libraryId: string) => Acquisition[] | undefined
  /** Marks a library as actively viewed (loads its queue once, then keeps it live via poll). */
  ensureQueueLoaded: (libraryId: string) => void
  refreshQueue: (libraryId: string) => Promise<void>
  applyAcquisition: (libraryId: string, acquisition: Acquisition) => void
}

export const AcquisitionContext = createContext<AcquisitionContextValue | undefined>(undefined)

/**
 * Mobile counterpart of src/contexts/AcquisitionContext.tsx. Deliberately poll-only, never
 * SSE: the web app's live updates work because a browser's same-origin EventSource
 * automatically resends the ABS session cookie, but ShelfDroid carries bearer tokens only
 * (no cookies -- see api/acquisitionClient.ts) and the stock EventSource API cannot attach a
 * custom Authorization header. The gateway's /acquisition-api/v1/events route
 * (services/acquisition-gateway/src/routes/events.ts) only accepts `authorization` or
 * `cookie`, so an unauthenticated EventSource connection would just 401 forever. Polling every
 * 10s for actively-viewed libraries is exactly the web app's own SSE-disconnected fallback
 * behavior, made permanent here rather than conditional.
 */
export function AcquisitionProvider({ children }: { children: ReactNode }) {
  const { acquisitionClient } = useAuth()
  const [status, setStatus] = useState<AcquisitionStatusResponse | null>(null)
  const [queues, setQueues] = useState<Record<string, Acquisition[]>>({})
  const activeLibraryIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!acquisitionClient) return
    let cancelled = false
    acquisitionClient
      .status()
      .then((response) => {
        if (!cancelled) setStatus(response)
      })
      .catch((error: unknown) => {
        console.error('Failed to load acquisition gateway status', error)
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [acquisitionClient])

  const refreshQueue = useCallback(
    async (libraryId: string) => {
      if (!acquisitionClient) return
      try {
        const acquisitions = await acquisitionClient.listAcquisitions(libraryId)
        setQueues((prev) => ({ ...prev, [libraryId]: acquisitions }))
      } catch (error) {
        console.error(`Failed to load acquisition queue for library ${libraryId}`, error)
      }
    },
    [acquisitionClient]
  )

  const ensureQueueLoaded = useCallback(
    (libraryId: string) => {
      if (activeLibraryIdsRef.current.has(libraryId)) return
      activeLibraryIdsRef.current.add(libraryId)
      void refreshQueue(libraryId)
    },
    [refreshQueue]
  )

  const applyAcquisition = useCallback((libraryId: string, acquisition: Acquisition) => {
    setQueues((prev) => {
      const existing = prev[libraryId] ?? []
      const index = existing.findIndex((item) => item.id === acquisition.id)
      const next = index === -1 ? [acquisition, ...existing] : existing.map((item, i) => (i === index ? acquisition : item))
      return { ...prev, [libraryId]: next }
    })
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      activeLibraryIdsRef.current.forEach((libraryId) => {
        void refreshQueue(libraryId)
      })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [refreshQueue])

  const isLibraryEnabled = useCallback((libraryId: string) => status?.libraries.some((library) => library.id === libraryId && library.enabled) ?? false, [status])

  const getQueue = useCallback((libraryId: string) => queues[libraryId], [queues])

  return (
    <AcquisitionContext.Provider value={{ status, isLibraryEnabled, getQueue, ensureQueueLoaded, refreshQueue, applyAcquisition }}>{children}</AcquisitionContext.Provider>
  )
}

export function useAcquisition(): AcquisitionContextValue {
  const context = useContext(AcquisitionContext)
  if (context === undefined) {
    throw new Error('useAcquisition must be used within an AcquisitionProvider')
  }
  return context
}
