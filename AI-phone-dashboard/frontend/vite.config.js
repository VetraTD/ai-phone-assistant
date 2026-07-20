import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
})
