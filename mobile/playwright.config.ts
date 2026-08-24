import { defineConfig } from '@playwright/test'

const FAKE_ABS_PORT = process.env.FAKE_ABS_PORT || '4545'
const DEV_PORT = process.env.PLAYWRIGHT_DEV_PORT || '4546'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${DEV_PORT}`,
    // Chromium blocks autoplay-without-a-gesture by default; PlayerPage starts playback from
    // a useEffect (after the click-driven navigation's own task), not synchronously inside a
    // click handler, so a plain headless run would spuriously reject audio.play(). This flag
    // is standard for automated media testing, not a production behavior change.
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] }
  },
  webServer: [
    {
      command: `node e2e/support/fakeAbsServer.mjs`,
      port: Number(FAKE_ABS_PORT),
      env: { FAKE_ABS_PORT },
      reuseExistingServer: !process.env.CI
    },
    {
      // Not `pnpm exec vite` -- bare `pnpm` is not guaranteed to be on PATH (this machine's
      // dev environment has it off PATH; `corepack pnpm ...` is required everywhere else in
      // this repo). `playwright test` itself is invoked through a package-manager script, so
      // node_modules/.bin is already on PATH here -- call the vite binary directly.
      command: `vite --port ${DEV_PORT} --strictPort --host 127.0.0.1`,
      port: Number(DEV_PORT),
      reuseExistingServer: !process.env.CI
    }
  ]
})
