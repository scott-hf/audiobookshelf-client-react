import type { DiscoverOptionsResponse } from '@abs/acquisition-contract'
import { useCallback, useEffect, useState } from 'react'
import type { MobileAcquisitionClient } from '../api/acquisitionClient'
import { useAuth } from '../auth/AuthProvider'
import { FOR_YOU_ID } from '../lib/discoverBrowse'
import { clientInstanceId } from './useLibraryIndex'

/** Minimal shape this hook needs -- lets tests inject a fake without mocking a module. */
export type DiscoverOptionsApi = Pick<MobileAcquisitionClient, 'getDiscoverOptions'>

/**
 * - `loading`: the options request is out (or there is no gateway client yet).
 * - `ready`: `options` is set; `options.catalogs` never contains {@link FOR_YOU_ID}.
 * - `hidden`: the gateway CONFIRMED it does not proxy discover (an older gateway). Browse is not
 *   offered at all and the page shows Search alone. There is no Retry in this state (the tab is not
 *   rendered); the answer expires after SETTLED_TTL_MS and the next consumer asks again.
 * - `error`: any other failure (network, timeout, 5xx). Transient, so the feature is NOT hidden;
 *   `retry()` asks again.
 */
export type DiscoverOptionsStatus = 'loading' | 'ready' | 'hidden' | 'error'

export interface UseDiscoverOptionsResult {
  options: DiscoverOptionsResponse | null
  status: DiscoverOptionsStatus
  retry: () => void
}

/**
 * How long a settled answer is trusted, matching `useLibraryIndex`'s CACHE_TTL_MS. A capability
 * answer is not permanent: the gateway can be deployed with the discover routes while the app is
 * running, and a catalog can be removed. After this the next consumer (a mount, or the effect
 * re-running for a new client) asks again.
 *
 * `hidden` renders no Discover tab at all, so there is NO Retry button in that state; this TTL is
 * what recovers a user who opened Discover before a deploy and comes back after it.
 */
const SETTLED_TTL_MS = 5 * 60 * 1000

type Settled = ({ kind: 'ready'; options: DiscoverOptionsResponse } | { kind: 'hidden' }) & { at: number }

// Keyed by client instance: a new login builds a new client, so a different server/account never
// sees these. Only SETTLED answers are kept (and only for SETTLED_TTL_MS); a failure is never
// cached, so retry really retries.
const settledByClient = new WeakMap<object, Settled>()
const inFlightByClient = new WeakMap<object, Promise<Settled>>()

/** The client's settled answer if it is still within the TTL; an expired one is dropped. */
function settledFor(api: object): Settled | undefined {
  const settled = settledByClient.get(api)
  if (!settled) return undefined
  if (Date.now() - settled.at > SETTLED_TTL_MS) {
    settledByClient.delete(api)
    return undefined
  }
  return settled
}

/** A confirmed "this gateway has no discover": the 404 the gateway/host answers with. */
function isNotSupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, status } = error as { code?: unknown; status?: unknown }
  return code === 'discover_not_supported' || status === 404
}

function load(api: DiscoverOptionsApi): Promise<Settled> {
  const existing = inFlightByClient.get(api)
  if (existing) return existing
  // A client that does not carry the method at all means the same thing to a user as a gateway
  // that does not serve the route: there is no way to browse, so hide the tab and leave Search
  // working. Treated here rather than thrown, because throwing would surface a TypeError as a
  // retryable network fault and offer a Retry button that could never succeed.
  if (typeof api.getDiscoverOptions !== 'function') {
    const settled: Settled = { kind: 'hidden', at: Date.now() }
    settledByClient.set(api, settled)
    return Promise.resolve(settled)
  }
  const pending: Promise<Settled> = api.getDiscoverOptions().then(
    (response) => {
      // The "For you" tab is client-only; a server catalog that collides with its id would make two
      // tabs share one id, so it is dropped here once rather than in every consumer.
      const settled: Settled = { kind: 'ready', options: { ...response, catalogs: response.catalogs.filter((catalog) => catalog.id !== FOR_YOU_ID) }, at: Date.now() }
      settledByClient.set(api, settled)
      return settled
    },
    (error: unknown) => {
      if (isNotSupported(error)) {
        const settled: Settled = { kind: 'hidden', at: Date.now() }
        settledByClient.set(api, settled)
        return settled
      }
      throw error
    }
  )
  inFlightByClient.set(api, pending)
  const release = () => {
    if (inFlightByClient.get(api) === pending) inFlightByClient.delete(api)
  }
  pending.then(release, release)
  return pending
}

interface State {
  /** Which client instance this state answers for; a state for another client is never shown. */
  clientId: number
  status: DiscoverOptionsStatus
  options: DiscoverOptionsResponse | null
}

function fromSettled(clientId: number, settled: Settled): State {
  return settled.kind === 'ready' ? { clientId, status: 'ready', options: settled.options } : { clientId, status: 'hidden', options: null }
}

function loadingFor(clientId: number): State {
  return { clientId, status: 'loading', options: null }
}

/**
 * Loads the discover catalogs and genres once per client instance. Switching tabs, or remounting the
 * page, reuses the settled answer (for {@link SETTLED_TTL_MS}) instead of asking the gateway again.
 *
 * The request is shared between consumers, so it is not aborted on unmount; an unmounted hook just
 * ignores the result.
 */
export function useDiscoverOptions(): UseDiscoverOptionsResult {
  const { acquisitionClient } = useAuth()
  const api: DiscoverOptionsApi | null = acquisitionClient
  const current = clientInstanceId(acquisitionClient)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State>(() => {
    const settled = api ? settledFor(api) : undefined
    return settled ? fromSettled(current, settled) : loadingFor(current)
  })

  useEffect(() => {
    if (!api) {
      setState(loadingFor(current))
      return
    }
    const settled = settledFor(api)
    if (settled) {
      setState(fromSettled(current, settled))
      return
    }
    let cancelled = false
    setState(loadingFor(current))
    load(api).then(
      (result) => {
        if (!cancelled) setState(fromSettled(current, result))
      },
      () => {
        if (!cancelled) setState({ clientId: current, status: 'error', options: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [api, current, attempt])

  // An explicit retry must really retry: drop this client's settled answer first, so the effect that
  // the attempt bump re-runs cannot just hand the cached one back.
  const retry = useCallback(() => {
    if (api) settledByClient.delete(api)
    setAttempt((n) => n + 1)
  }, [api])

  // Between a client change and the effect that resets state, never show the previous client's answer.
  const view = state.clientId === current ? state : loadingFor(current)

  return { options: view.options, status: view.status, retry }
}
