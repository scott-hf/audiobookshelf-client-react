import { defineConfig } from 'cypress'
import path from 'path'
// Next vendors its own webpack build (not a plain 'webpack' devDependency at the workspace
// root) -- reuse that instance's NormalModuleReplacementPlugin rather than adding a second
// webpack install.
import { webpack } from 'next/dist/compiled/webpack/webpack'

export default defineConfig({
  component: {
    specPattern: 'cypress/tests/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: 'cypress/support/component.tsx',
    devServer: {
      framework: 'next',
      bundler: 'webpack',
      webpackConfig: {
        resolve: {
          alias: {
            '@': path.resolve(__dirname, 'src')
          }
        },
        plugins: [
          // 'use server' action modules that transitively import src/lib/api.ts (which has a
          // top-level `next/headers` import) fail to compile under Cypress's component
          // testing bundle -- see cypress/support/mocks/libraryActions.ts for the full
          // explanation. A plain `resolve.alias` entry does NOT reliably win here: Next's own
          // generated config already contributes a broader '@' alias ahead of anything we add
          // to our own config object (object-merge preserves the pre-existing key's earlier
          // position), so it always matches first. NormalModuleReplacementPlugin taps
          // `beforeResolve`, which runs before alias resolution, so it wins unconditionally.
          // Add further replacements here if another action module hits the same wall.
          new webpack.NormalModuleReplacementPlugin(/^@\/app\/actions\/libraryActions$/, path.resolve(__dirname, 'cypress/support/mocks/libraryActions.ts'))
        ]
      }
    },
    setupNodeEvents(on) {
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.path?.includes('BraveSoftware')) {
          launchOptions.args.push('--no-first-run')
          launchOptions.args.push('--no-default-browser-check')
          launchOptions.args.push('--profile-directory=Default')
        }
        return launchOptions
      })
    }
  },
  // Real browser-driven journeys against a genuinely running `next dev` server (see
  // docs/implementation-status.md Gate 4 for how to stand up its two disposable dependencies
  // -- cypress/e2e/support/fakeAbsServer.mjs and the /acquisition-api/v1/* cy.intercept calls
  // in the spec itself -- before running this project).
  e2e: {
    baseUrl: 'http://localhost:3000',
    specPattern: 'cypress/e2e/**/*.cy.ts',
    supportFile: 'cypress/support/e2e.ts'
  }
})
