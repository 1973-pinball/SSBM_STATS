import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { Analytics } from '@vercel/analytics/react'
// Self-hosted fonts (was Google Fonts): same-origin, hashed, immutable-cached.
//
// Subset imports, not the bare weight files. `@fontsource/inter/400.css` ships
// every subset the family publishes — cyrillic, greek, vietnamese, thai — and
// all of it lands in the render-blocking stylesheet on a site that is
// `lang="en"`. latin-ext stays because player tags carry accented characters.
import '@fontsource/chakra-petch/latin-500.css'
import '@fontsource/chakra-petch/latin-ext-500.css'
import '@fontsource/chakra-petch/latin-600.css'
import '@fontsource/chakra-petch/latin-ext-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-ext-400.css'
import '@fontsource/ibm-plex-mono/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-ext-600.css'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-ext-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-ext-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-ext-600.css'
import './index.css'
import App from './App.tsx'

// Views are lazy-loaded, so a tab left open across a deploy 404s when it
// tries to fetch a chunk whose hashed filename no longer exists. Vite fires
// vite:preloadError for exactly this; reload once to pick up the new build.
// The timestamp guard stops a reload loop if a chunk is genuinely missing.
window.addEventListener('vite:preloadError', (event) => {
  const last = Number(sessionStorage.getItem('chunk-reload-at') ?? 0)
  if (Date.now() - last < 30_000) return // let the error surface instead of looping
  sessionStorage.setItem('chunk-reload-at', String(Date.now()))
  event.preventDefault()
  window.location.reload()
})

/**
 * The service worker precaches the whole shell, so a tab that stays open never
 * sees a new deploy: it keeps serving what it cached, however far behind that
 * falls. registerType 'autoUpdate' lets the new worker activate as soon as it
 * is ready; App only defers the page reload while local parsing is active.
 *
 * Only while visible and online: a backgrounded tab has nobody to show the new
 * build to, and an offline check just fails. Picking up a new worker triggers
 * an idle-safe reload instead of leaving a manual prompt stuck on screen.
 */
const UPDATE_CHECK_MS = 60 * 60 * 1000

registerSW({
  immediate: true,
  // Keep an update from reloading through an active folder parse. App owns the
  // final page reload and waits until local work is idle.
  onNeedReload() {
    window.dispatchEvent(new CustomEvent('ssbm:update-applied'))
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent('ssbm:offline-ready'))
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return
      void registration.update()
    }, UPDATE_CHECK_MS)
  },
})

// index.html ships a static heading, lede and nav so a crawler that never runs
// this bundle still gets prose and the /about, /metrics and /melee-majors
// links. Landing renders the real thing, so the placeholder goes as React
// takes over.
document.getElementById('static-shell')?.remove()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* Aggregate, cookieless pageview counts. Vercel auto-injects this beacon
        on Next.js but not on Vite, so it is mounted by hand or nothing is ever
        recorded. Counts visits only — nothing per-visitor. */}
    <Analytics />
  </StrictMode>,
)
