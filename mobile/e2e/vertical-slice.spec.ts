import { expect, test } from '@playwright/test'

const FAKE_ABS_URL = `http://127.0.0.1:${process.env.FAKE_ABS_PORT || '4545'}`

/**
 * Smoke-tests the full ShelfDroid vertical slice (t600 Task 6) against the disposable fake
 * ABS + acquisition-gateway backend in e2e/support/fakeAbsServer.mjs: login -> browse ->
 * item details -> stream -> Discover search -> acquire -> queue state. Runs the Vite dev
 * server directly (see playwright.config.ts's webServer) rather than the packaged Capacitor
 * WebView -- a real device/emulator run is out of scope here (t650, `@user`, gated on t600).
 */
test('login, browse, stream, discover, acquire, and see the queue update', async ({ page }) => {
  await page.goto('/')

  await page.getByLabel('Server address').fill(FAKE_ABS_URL)
  await page.getByLabel('Username').fill('e2e-admin')
  await page.getByLabel('Password').fill('password')
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Browse.
  await expect(page.getByText('E2E Library')).toBeVisible()
  await page.getByText('E2E Library').click()
  await expect(page.getByText('Project Hail Mary')).toBeVisible()
  await page.getByText('Project Hail Mary').click()

  // Item details + stream.
  await expect(page.getByRole('heading', { name: 'Project Hail Mary' })).toBeVisible()
  await page.getByRole('link', { name: 'Play' }).click()
  await expect(page.locator('.player-status')).toHaveText('playing', { timeout: 10_000 })

  // Discover -> acquire. Navigate via in-app history (page.goBack()) + the Discover nav
  // link, NOT page.goto() -- this SPA's session lives only in React memory in a plain
  // browser (secureVault's native bridge is Android-only; see native/secureSession.ts),
  // so a full page.goto() navigation reloads the app, drops the session, and bounces back
  // to the login screen, exactly what made this step hang waiting for a search field that
  // was never rendered.
  await page.goBack() // book details -> library item details page back to library list
  await page.goBack() // -> library page
  await page.getByRole('link', { name: 'Discover' }).click()
  await page.getByLabel('Search audiobooks').fill('Project Hail Mary')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('release-card')).toBeVisible()
  await page.getByRole('button', { name: 'Acquire' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Acquire' }).click()

  // Queue state.
  await expect(page).toHaveURL(/acquisition-queue$/)
  await expect(page.getByTestId('acquisition-row')).toBeVisible()
  await expect(page.getByText('Queued')).toBeVisible()
})
