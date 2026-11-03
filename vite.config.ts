import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execFileSync } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

// Vite's static handler treats *.json.gz as encoded JSON. These shards are
// explicit gzip payloads: the client verifies compressed bytes before decoding.
function opaqueRankedShards(): Plugin {
  let publicDir = ''
  let previewDir = ''
  const shardPath = /^\/ranked\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/(diamond|master)-(all|[0-9]|1[0-9]|2[0-5])\.json\.gz$/
  const serve = (directory: string): Connect.NextHandleFunction => async (req, res, next) => {
    const pathname = req.url?.split('?')[0] ?? ''
    if (!directory || !shardPath.test(pathname) || !['GET', 'HEAD'].includes(req.method ?? '')) return next()
    try {
      const root = await realpath(directory)
      const filename = await realpath(path.join(root, pathname.slice(1)))
      const relative = path.relative(root, filename)
      // Resolve symlinks as well as URL components before allowing file access.
      if (!shardPath.test('/' + relative.split(path.sep).join('/'))) {
        res.statusCode = 403
        res.end()
        return
      }
      const bytes = await readFile(filename)
      res.removeHeader('Content-Encoding')
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Length', bytes.length)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) {
        res.statusCode = 404
        res.end()
      } else next(error)
    }
  }
  return {
    name: 'opaque-ranked-shards',
    configResolved(config) {
      publicDir = config.publicDir
      previewDir = path.resolve(config.root, config.build.outDir)
    },
    configureServer(server) { server.middlewares.use(serve(publicDir)) },
    configurePreviewServer(server) { server.middlewares.use(serve(previewDir)) },
  }
}

const buildId = (() => {
  const vercelCommit = process.env.VERCEL_GIT_COMMIT_SHA?.trim()
  if (vercelCommit) return vercelCommit.slice(0, 7)
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'local'
  }
})()

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    opaqueRankedShards(),
    react(),
    VitePWA({
      // New deploys activate immediately; App defers only the visible page
      // reload when local parsing is active.
      registerType: 'autoUpdate',
      // Registered by hand in main.tsx so it can poll for new deploys — a tab
      // left open otherwise never re-checks, and keeps serving the precached
      // shell no matter how many times it's released behind.
      injectRegister: null,
      manifest: {
        id: '/',
        name: 'SSBM Stats',
        short_name: 'SSBM Stats',
        description:
          'Private Slippi replay analytics and Melee history, parsed entirely in your browser.',
        start_url: '/',
        scope: '/',
        lang: 'en-US',
        display: 'standalone',
        background_color: '#121022',
        theme_color: '#121022',
        categories: ['games', 'sports', 'utilities'],
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          {
            name: 'Open my stats',
            short_name: 'My stats',
            url: '/?view=overview',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Open Community Lab',
            short_name: 'Community',
            url: '/?view=community',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Browse Melee history',
            short_name: 'Melee history',
            url: '/?view=liquipedia',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
      workbox: {
        // Keep this explicit because injectRegister is disabled; already-open
        // tabs need the new worker to take control before App can reload.
        skipWaiting: true,
        clientsClaim: true,
        // Precache every build asset (all views are lazy chunks — offline needs
        // them all); fonts are hashed woff2 files, safe to cache immutably.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The lazy experimental interaction reference contains exact matchup /
        // stage counters (~2.7 MB before transfer compression). Keep it available
        // offline alongside the other Execution data.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // public/share holds the generated share images — multi-megabyte GIFs
        // plus their posters. They're for sending to other people, not for
        // running the app, so they stay out of the offline bundle.
        // Ranked references load only the selected character's immutable shard.
        // Do not force every public cohort into the offline app installation.
        globIgnores: ['**/share/**', '**/ranked/**'],
        navigateFallback: '/index.html',
        // The static pages rendered by scripts/render-seo-pages.mjs are real
        // documents at their own URLs. Without this the service worker answers
        // those navigations from the precached app shell, so anyone who has
        // already loaded the site would get the SPA instead of the page. The
        // .html form is covered too: cleanUrls 308s it to the extensionless
        // URL, but the worker answers from cache before any redirect happens.
        //
        // The tail is deliberately loose. Workbox tests this against
        // `url.pathname + url.search`, not the pathname alone, so anchoring
        // straight after `.html` covered the bare URL and nothing else: a
        // shared link carrying `?utm_source=`, `?fbclid=` or Twitter's `?s=20`
        // — and `/about/` with a trailing slash — fell through to the default
        // allowlist and got the app shell. Nothing could rescue it either,
        // since these pages are written after `vite build` and so are absent
        // from the precache manifest. Invisible to Googlebot, which registers
        // no worker; it only ever hit returning humans following a link.
        navigateFallbackDenylist: [/^\/(about|metrics|melee-majors)(\.html)?\/?(\?|$)/, /^\/ranked\//],
      },
    }),
  ],
})
