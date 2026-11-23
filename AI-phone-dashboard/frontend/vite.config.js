import { readFileSync } from 'node:fs'
import { cwd } from 'node:process'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { apiAddressProblem, missingConnectOrigins } from './cspGuard.js'

// The app build (Firebase Hosting) fails when the API addresses it was given
// are not allowed by the Content-Security-Policy in firebase.json: such a build
// would load, then have every request blocked. See cspGuard.js.
function cspFollowsApi(env, mode) {
  return {
    name: 'csp-follows-api',
    apply: 'build',
    buildStart() {
      if (env.VITE_BUILD_TARGET !== 'app') return
      if (mode === 'production') {
        const problem = apiAddressProblem(env.VITE_API_URL, { localBuild: process.env.VETRA_LOCAL_BUILD === '1' })
        if (problem) this.error(problem)
      }
      const firebaseJson = JSON.parse(readFileSync(new URL('./firebase.json', import.meta.url), 'utf8'))
      const missing = missingConnectOrigins(firebaseJson, [env.VITE_API_URL, env.VITE_NUMBER_API_URL])
      if (missing.length) {
        this.error(
          `firebase.json's Content-Security-Policy does not allow ${missing.join(', ')}. ` +
            'Add it to connect-src, or the dashboard will be blocked from its own API.'
        )
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, cwd(), 'VITE_')
  return {
    plugins: [react(), cspFollowsApi(env, mode)],
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/setupTests.js'],
      css: false,
      // Needed so @testing-library/react's automatic afterEach(cleanup) can
      // register itself (it hooks into the global afterEach) — without this,
      // unmounted components from a previous test linger in the DOM and
      // multi-test files see duplicate elements.
      globals: true,
    },
  }
})
