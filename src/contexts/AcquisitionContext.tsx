'use client'

import { acquisitionClient, type AcquisitionStatusResponse } from '@/lib/acquisition'
import type { Acquisition } from '@abs/acquisition-contract'
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'

const POLL_INTERVAL_MS = 10_000
/** Cypress-only escape hatch: a real EventSource cannot be forced into an error state from a
 * component test without a live server. Dispatching this window event exercises the exact same
 * handler a genuine EventSource 'error' would, so it is a legitimate test of the fallback path,
 * not a production backdoor -- it never fires outside a test dispatching it explicitly. */
const TEST_SSE_ERROR_EVENT = 'test-acquisition-sse-error'

export interface AcquisitionContextValue {
  status: AcquisitionStatusResponse | null
  isLibraryEnabled: (libraryId: string) => boolean
  getQueue: (libraryId: string) => Acquisition[] | undefined
  /** Marks a library as actively viewed (loads its queue once, keeps it live via SSE/poll). */
  ensureQueueLoaded: (libraryId: string) => void
  refreshQueue: (libraryId: string) => Promise<void>
  applyAcquisition: (libraryId: string, acquisition: Acquisition) => void
}

export const AcquisitionContext = createContext<AcquisitionContextValue | undefined>(undefined)

export function AcquisitionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AcquisitionStatusResponse | null>(null)
  const [queues, setQueues] = useState<Record<string, Acquisition[]>>({})
  const [sseConnected, setSseConnected] = useState(false)
  const activeLibraryIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    acquisitionClient
      .status()
      .then((response) => {
        if (!cancelled) setStatus(response)
      })
      .catch((error) => {
        console.error('Failed to load acquisition gateway status', error)
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshQueue = useCallback(async (libraryId: string) => {
    try {
      const acquisitions = await acquisitionClient.listAcquisitions(libraryId)
      setQueues((prev) => ({ ...prev, [libraryId]: acquisitions }))
    } catch (error) {
      console.error(`Failed to load acquisition queue for library ${libraryId}`, error)
    }
  }, [])

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

  // SSE connection: refresh every actively-viewed library's queue on any event (events are
  // already scoped server-side to the authenticated user; the event payload only carries
  // acquisitionId, not libraryId, so a broad refresh of active libraries is the correct scope).
  useEffect(() => {
    if (typeof EventSource === 'undefined') return

    const eventSource = new EventSource('/acquisition-api/v1/events')

    const handleOpen = () => setSseConnected(true)
    const handleError = () => setSseConnected(false)
    const handleAcquisitionEvent = () => {
      activeLibraryIdsRef.current.forEach((libraryId) => {
        void refreshQueue(libraryId)
      })
    }

    eventSource.addEventListener('open', handleOpen)
    eventSource.addEventListener('error', handleError)
    eventSource.addEventListener('acquisition.created', handleAcquisitionEvent)
    eventSource.addEventListener('acquisition.updated', handleAcquisitionEvent)
    window.addEventListener(TEST_SSE_ERROR_EVENT, handleError)

    return () => {
      eventSource.close()
      window.removeEventListener(TEST_SSE_ERROR_EVENT, handleError)
    }
  }, [refreshQueue])

  // Polling fallback: only while SSE is disconnected, only for actively-viewed libraries.
  useEffect(() => {
    if (sseConnected) return
    const interval = setInterval(() => {
      activeLibraryIdsRef.current.forEach((libraryId) => {
        void refreshQueue(libraryId)
      })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [sseConnected, refreshQueue])

  const isLibraryEnabled = useCallback((libraryId: string) => status?.libraries.some((library) => library.id === libraryId && library.enabled) ?? false, [status])

  const getQueue = useCallback((libraryId: string) => queues[libraryId], [queues])

  return (
    <AcquisitionContext.Provider value={{ status, isLibraryEnabled, getQueue, ensureQueueLoaded, refreshQueue, applyAcquisition }}>
      {children}
    </AcquisitionContext.Provider>
  )
}

export function useAcquisition(): AcquisitionContextValue {
  const context = useContext(AcquisitionContext)
  if (context === undefined) {
    throw new Error('useAcquisition must be used within an AcquisitionProvider')
  }
  return context
}
