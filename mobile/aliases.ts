import { fileURLToPath } from 'node:url'

/**
 * Shared module aliases for vite (build/dev) and vitest.
 *
 * `@/...` mirrors the upstream Next.js client's path alias so components ported
 * from src/components/ui keep their original import specifiers and stay diffable.
 * `next/link` resolves to a react-router-backed shim for the same reason.
 *
 * Lives outside src/ so it is never pulled into the browser bundle.
 */
export const sharedAliases = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  'next/link': fileURLToPath(new URL('./src/shims/next-link.tsx', import.meta.url))
}
