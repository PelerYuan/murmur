# Murmur web UI

Single-page app for Murmur core: dashboard, timeline, summaries, to-dos, speakers, recorders, settings and first-run onboarding. Vite + React 18 + TypeScript (strict), React Router, TanStack Query, Tailwind, lucide-react. It makes no external network requests at runtime (no CDN, no web fonts).

Contract: `docs/API.md`. UX: `docs/PRODUCT.md`.

## Develop

```bash
source ~/.nvm/nvm.sh        # Node 20+ (developed on 24)
cd web
npm install
npm run dev                 # http://127.0.0.1:5173
```

The dev server proxies `/api` and `/healthz` to `VITE_API_TARGET` (default `http://127.0.0.1:8010`):

```bash
VITE_API_TARGET=http://192.168.1.10:8000 npm run dev
```

Session cookies are same-origin through the proxy, so login works unchanged.

## Build

```bash
npm run build               # tsc --noEmit && vite build  ->  web/dist
npm run typecheck
npm test                    # vitest run (pure logic only)
```

`dist/` is a static bundle. Serve it from the same origin as the API (core serves it, or put a reverse proxy in front); the app uses root-relative `/api/...` URLs and `BrowserRouter`, so the server must fall back to `index.html` for unknown non-API paths.

## Structure

```
src/
  main.tsx, App.tsx          providers, routes (lazy pages)
  pages/                     one file per route
  components/
    ui/                      own primitives (Button, Dialog, Select, Switch, Popover, Toast, ...)
    shell/                   sidebar / bottom tab bar, status indicators, LiveSync
    timeline/ summaries/ todos/ speakers/ recorders/ settings/ welcome/ reminders/
  hooks/                     data hooks, form state (useGroupForm), guards, virtualisation
  lib/                       pure logic (time, conversation grouping, settings diff/validation,
                             recorder config, onboarding diagnosis, ...) plus *.test.ts
  i18n/                      index.tsx (provider, dict registry), core.ts (defineDict, translate), dict/*.ts
```

Routes: `/login`, `/welcome` (onboarding), `/` (dashboard), `/timeline`, `/summaries`, `/todos`, `/speakers`, `/speakers/:id`, `/recorders`, `/settings/:section`. Keyboard: `g` then `d`/`t`/`s`/`o`/`p`/`r`/`c` jumps to dashboard/timeline/summaries/to-dos/speakers/recorders/settings, `?` for the cheat sheet.

Notes on design choices:

- Server state lives in TanStack Query (`lib/queryClient.ts` `qk`). One shared `EventSource` (`lib/events.tsx`) feeds `LiveSync`, which turns SSE events into cache invalidations; polling is a fallback only.
- All dates are formatted with `Intl` in `settings.general.timezone` via `useFmt()`; never `toLocale*` with the browser zone.
- Long lists (timeline, speakers) are virtualised against the shell scroller `main#main`.
- Settings use `useGroupForm`: the draft is diffed against the saved group and only changed leaves are sent. Secrets are `"***"` (set) or `""` (unset); the UI never shows them. 422 details of the form `group.path: message` are attached to the matching field. The connection tests use the saved settings, so the "save and test" buttons save first.
- Reminders: SSE plus `/reminders/due`; with several tabs open, a leader tab (BroadcastChannel election) plays the chime. Mute and desktop-notification choices are in localStorage.
- Onboarding is stateless: progress is derived from the server (rooms, recorders, ASR, utterances). Only the "skipped" flags are local.

## i18n

Chinese is the default, English is complete. Language is switchable without reload and persisted (`murmur.lang`).

1. Add keys to the matching file in `src/i18n/dict/`: `export default defineDict({ 'x.key': '中文' }, { 'x.key': 'English' })`. TypeScript fails the build if the two sides have different keys.
2. Use them with `const t = useT(); t('x.key', { n: 3 })` (`{n}` placeholders).
3. A new dict file must be imported and merged in `src/i18n/index.tsx` (both the `dicts` object and the `TKey` union).

Fallback order is current language, then Chinese, then the key itself.

## Local storage keys

`murmur.theme`, `murmur.lang`, `murmur.me`, `murmur.reminder.mute`, `murmur.reminder.notify`, `murmur.onboarding.skipped`, `murmur.onboarding.skip_llm`; sessionStorage `murmur.gate`. All reads and writes are wrapped, so the app works with storage blocked.

## Known limitations

- The unsaved-changes guard on Settings covers reload, closing the tab, in-app links and section switches. The browser Back button and the `g` shortcuts are not guarded (BrowserRouter has no blocker API).
- The volume bar on the recorder card follows heartbeats, so it refreshes about every 10 s.
- No merge suggestions for speakers.
