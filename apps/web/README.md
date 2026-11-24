# apps/web: Poultry Analytics frontend

A single-page app built with HTML5, CSS3, Bootstrap 5, vanilla JavaScript (ES modules), Chart.js 4 and Lucide icons. It's bundled with Vite and runs on Bun.

The frontend talks to the Flask API only over HTTP (`VITE_API_BASE_URL`), so it doesn't depend on how the backend is implemented.

## Commands

```bash
bun run dev       # http://localhost:5173 (proxies /api → Flask on :5000)
bun run build     # production build → dist/
bun run preview   # serve the production build
bun run test      # unit tests (bun:test)
```

From the repo root, `bun run dev` / `build` / `test` run the same tasks through Turborepo.

## Configuration

All settings are read in `src/config.js` from `VITE_*` variables in the repo-root `.env` (see `.env.example`). They end up in the browser bundle, so **never put secrets in them**.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `/api` | API base URL. A relative path uses the dev proxy. |
| `VITE_DEV_API_TARGET` | `http://127.0.0.1:5000` | Where the dev proxy forwards `/api`. |
| `VITE_DEMO_MODE` | `false` | Preview mode (see below). Opt-in only. |
| `VITE_API_TIMEOUT_MS` | `20000` | Request timeout. |
| `VITE_MAX_UPLOAD_MB` | `50` | Client-side CSV size limit (the server enforces its own). |

### Preview mode and data integrity

Preview mode lets you review the interface before the backend exists:

- Read-only views (dashboard, farms, batches, analytics, predictions, users, audit) show **sample data** generated from a fixed seed in `src/services/sample/`. Every view that shows it has a **Sample data** badge, and sample farm names contain "Sample".
- These **never** use sample data: sign-in, every save action, CSV upload and the ingestion pipeline, HDFS/Hive status, HiveQL execution, model evaluation metrics, and reports. They always call the real API, and show an honest "backend not connected" state when it's unavailable.
- If the API can't be reached, you browse as an unauthenticated **Preview visitor**. This grants no server access.

It's off by default, because the Flask API is connected. Pages then show real API (Hive) results, or the real error when the API is down. Set `VITE_DEMO_MODE=true` only to review the UI without a backend.

## Structure

```
src/
  main.js            entry: global styles + router
  config.js          central configuration
  router.js          hash router, page lifecycle, auth guard
  routes.js          route table (lazy-loaded pages)
  navigation.js      sidebar groups and items
  layouts/           app shell (sidebar, top bar, search, notifications) and auth layout
  pages/             one module per page: export default { title, render(root, ctx) }
  components/        icons, ui (cards, KPI, badges), dataTable, modal, toast, states
  charts/            Chart.js registration, theme and chart factories
  services/          apiClient (fetch wrapper, ApiError), domain services, sample/
  styles/            tokens.css (design system), base, layout, components, auth, pages/
  utils/             dom (safe html templates), format, csv, validation
tests/               bun:test unit tests
```

## Conventions

- **Safe rendering:** build markup with the `html` tagged template from `utils/dom.js`, which escapes every value automatically. Use `raw()` only for markup produced by our own components.
- **Design tokens:** use the CSS variables in `styles/tokens.css` and never hard-code colours or spacing. Chart colours are mirrored in `charts/index.js`.
- **Page lifecycle:** register listeners and timers with `ctx.onCleanup`. After any `await`, check `ctx.isCurrent()` before rendering. The router destroys charts automatically.
- **Services:** reads return `{ data, source }`. Show `sourceBadge(source)` next to anything rendered from them. Writes return the API response or throw an `ApiError`.
- **States:** every async section needs loading, empty and error states (`components/states.js`). Error states include a `data-action="retry"` button.
- **API contract:** the endpoints and payload shapes the frontend expects are documented at the top of each `services/*.js` file. The backend (stage 3 onwards) must implement them.
