# @do-soul/alaya-inspector

Memory Inspector — a memory-tooling loopback surface for Alaya. Per
the project invariants this is **not** an agent surface and does not
participate in agent control flow; it is a developer/operator window
into the memory ontology.

## Architecture

This package ships two concerns under one published artifact:

- **`src/`** — Hono backend that proxies the Alaya core daemon, serves
  authenticated routes (`/graph`, `/config`, `/proposals`, `/status`),
  and serves the SPA static assets out of `web/dist/`.
- **`web/`** — Vite + React + Tailwind SPA (nested package
  `@do-soul/alaya-inspector-web`, marked `private`). It is built into
  `web/dist/` and shipped inside this same package's `files` field.

The CLI launcher (`alaya inspect`) lives in
`apps/core-daemon/src/cli/inspect.ts` and spawns this package's
`dist/runtime/server.js` as a managed child process. The printed URL
contains a one-time `launch` query code — not the inspector bearer token.
The SPA redeems that code via loopback `POST /api/launch-session`, stores
the token in `sessionStorage`, and sends it on subsequent requests as
`X-Alaya-Inspector-Token`. The daemon URL is hard-coded to
`http://127.0.0.1:5173` in `src/runtime/app.ts`; the inspector itself
defaults to port `5174` (see CLI launcher for collision logic).

## Configuration

The config page reads daemon runtime parameters. Embedding and Garden
provider/secret forms are intentionally read-only: the Inspector PATCH
routes deny process-level runtime config writes and never edit provider
secrets. Configure those values through the supported CLI path
(`alaya install --non-interactive '<answers-json>'` or
`alaya install --keychain`). The strategy flags are displayed as stored
values only; no runtime consumer enforces them, so changing them does not
change agent policy.

Inspector proposal review uses the daemon's reviewer binding. When both
`ALAYA_REVIEWER_TOKEN` and `ALAYA_REVIEWER_IDENTITY` are configured,
`alaya inspect` forwards the pair to this child, review requests carry it,
and a request-supplied identity cannot override it. Without that pair,
Inspector review is refused.

## Dev

```bash
# from repo root
pnpm install
pnpm --dir apps/inspector/web dev      # SPA dev server (Vite)
pnpm --dir apps/core-daemon dev        # daemon, required by the inspector
alaya inspect                              # end-to-end launch via CLI
```

## Build

```bash
pnpm --filter @do-soul/alaya-inspector build
```

This runs `tsc -b` for the backend and then `pnpm --dir web build` for
the frontend, producing `dist/` and `web/dist/` respectively. Both are
included in the published `files` field.

## Tests

```bash
pnpm exec vitest run --project @do-soul/alaya-inspector       # backend
pnpm exec vitest run --project @do-soul/alaya-inspector-web   # frontend
```
