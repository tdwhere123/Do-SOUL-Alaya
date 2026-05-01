# Implementation Brief: Task P4-inspector-server — Implement apps/inspector HTTP server

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-inspector-server
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/inspector/package.json`, `apps/inspector/tsconfig.json`, `apps/inspector/src/server.ts`, `apps/inspector/src/auth.ts`, `apps/inspector/src/routes/config.ts`, `apps/inspector/src/routes/graph.ts`, `apps/inspector/src/routes/status.ts`, `apps/inspector/src/static.ts`, `apps/inspector/src/__tests__/auth.test.ts`, `apps/inspector/src/__tests__/routes.test.ts`
> - **Size**: M
> - **Prerequisite**: P4-cli-bridge, P4-secrets, P4-routes-config, P4-routes-soul, P4-trust-state
> - **Blocks**: P4-cli-inspect, P4-inspector-frontend, Gate-4 demo
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-inspector-server";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21` (narrowed 2026-04-29 to permit the
Memory Inspector as a memory-tooling surface; Inspector writes are
limited to daemon runtime parameters);
`docs/handbook/architecture.md §Surface Shape`.

## 1. Background & Goal

**Background**: The Memory Inspector is a separate process that
serves a 3-page SPA against the daemon's HTTP routes. The server in
this card is the back end: token-authenticated middleware, a small
set of proxy routes that read from / write to the daemon's existing
config / graph / status endpoints, and static asset hosting for the
SPA bundle that P4-inspector-frontend builds. Closes the server half
of backlog #BL-012.

**Goal**: A `node apps/inspector/dist/server.js` process that listens
on `127.0.0.1:<port>`, refuses every request without a valid token
match, proxies a frozen subset of daemon HTTP routes (read: graph +
status + config; write: config only), and serves the SPA static
bundle. The frozen route subset is what the SPA's three pages need
and nothing else.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/inspector/package.json` | New package; `name: "@do-soul/alaya-inspector"`, type module, depends on `hono`, `@do-soul/alaya-protocol`, no dependency on `@do-soul/alaya-core` or `@do-soul/alaya-storage` (this surface uses HTTP, not core/storage imports). |
| `n/a` | `apps/inspector/tsconfig.json` | Extends repo root tsconfig; outputs to `apps/inspector/dist/`. |
| `n/a` | `apps/inspector/src/server.ts` | HTTP server entry; reads `ALAYA_INSPECTOR_TOKEN` from env, binds to `127.0.0.1:<port>`, registers middleware + routes, prints `inspector_ready` to stdout when ready. |
| `n/a` | `apps/inspector/src/auth.ts` | Token middleware: parses `?token=` from URL or `X-Alaya-Inspector-Token` header; constant-time compare against the in-process token. |
| `n/a` | `apps/inspector/src/routes/config.ts` | GET `/api/config/:workspaceId/{soul,strategy,environment}` (proxy to daemon); PATCH same paths. Schema-validates the patch body using `@do-soul/alaya-protocol` schemas before forwarding. |
| `n/a` | `apps/inspector/src/routes/graph.ts` | GET `/api/graph/:workspaceId` (proxy to daemon's soul-graph route, read-only). |
| `n/a` | `apps/inspector/src/routes/status.ts` | GET `/api/status` (proxy to daemon's status route, read-only). |
| `n/a` | `apps/inspector/src/static.ts` | Serves `apps/inspector/web/dist/` static assets at `/`; falls back to `index.html` for client-side routing. |
| `n/a` | `apps/inspector/src/__tests__/auth.test.ts` | Token middleware tests (missing / wrong / right). |
| `n/a` | `apps/inspector/src/__tests__/routes.test.ts` | Route proxy tests using a mock daemon. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md §3` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Behavior

**Auth.**
- Token sourced from `ALAYA_INSPECTOR_TOKEN` env var at process
  start; absent or empty → process exits with code 2 and prints
  `inspector_token_missing` to stderr.
- Every request MUST present the token via either `?token=<hex>` or
  `X-Alaya-Inspector-Token: <hex>`. Missing or mismatching → 401
  with body `{"error":"unauthorized"}`. Constant-time comparison
  required to prevent timing leaks.
- The token MUST NEVER appear in audit, logs, or response bodies.

**Bind.**
- Bind to `127.0.0.1` only. The bind address is hardcoded; no
  configuration surface exposes a non-loopback bind. Tests assert
  this.
- Port is taken from the `--port` flag forwarded by P4-cli-inspect
  via the `ALAYA_INSPECTOR_PORT` env var; default `5174`.

**Daemon URL discovery.**
- The Inspector talks HTTP to `core-daemon`. Daemon URL is sourced
  from `ALAYA_DAEMON_URL` env var (default
  `http://127.0.0.1:5173`). The Inspector itself MUST NOT import
  any daemon code; it is a strict HTTP client.

**Frozen route surface (v0.1).** Exactly these and nothing more:

| Method | Path | Daemon route proxied | Body / response |
|---|---|---|---|
| GET | `/api/config/:wsId/soul` | `GET /workspaces/:wsId/config/soul` | `SoulConfig` |
| PATCH | `/api/config/:wsId/soul` | `PATCH /workspaces/:wsId/config/soul` | partial `SoulConfig` |
| GET | `/api/config/:wsId/strategy` | `GET /workspaces/:wsId/config/strategy` | `StrategyConfig` |
| PATCH | `/api/config/:wsId/strategy` | `PATCH /workspaces/:wsId/config/strategy` | partial `StrategyConfig` |
| GET | `/api/config/:wsId/environment` | `GET /workspaces/:wsId/config/environment` | `EnvironmentConfig` |
| PATCH | `/api/config/:wsId/environment` | `PATCH /workspaces/:wsId/config/environment` | partial `EnvironmentConfig` |
| GET | `/api/config/:wsId/embedding-supplement` | `GET /config/runtime/embedding-supplement` | `RuntimeEmbeddingConfig` |
| PATCH | `/api/config/runtime/embedding-supplement` | `PATCH /config/runtime/embedding-supplement` | `{ provider_url?, model_id?, secret_ref?, embedding_enabled?, requires_daemon_restart }` |
| GET | `/api/graph/:wsId` | `GET /workspaces/:wsId/soul/graph` | `SoulGraph` |
| GET | `/api/status` | `GET /status` | `AlayaStatus` |

The `PATCH /api/config/runtime/embedding-supplement` path is a thin
Inspector proxy. The daemon owns `.env` envelope resolution, pasted
secret normalization, secret-file writes, config mutation, and the
EventLog audit row because provider secrets are daemon-only runtime
configuration. Resolved plaintext is passed directly to daemon provider
instances and is never forwarded to the Inspector child process. After
the daemon write, the response includes
`{"requires_daemon_restart": true}` so the SPA can prompt the user.

**No other writes.** Memory CRUD, governance overrides, attach /
detach mutation, secret rotation beyond the embedding-supplement
panel — all forbidden in v0.1 per invariant §21 narrowed wording
("Inspector writes are limited to daemon runtime parameters").

**Static assets.**
- `GET /` serves `apps/inspector/web/dist/index.html`.
- Static asset paths under `/assets/...` resolve to
  `apps/inspector/web/dist/assets/...`.
- Any non-`/api/...` path that is not an existing static file falls
  through to `/`'s `index.html` to support client-side routing.
- The static handler MUST NOT serve files outside
  `apps/inspector/web/dist/` (path traversal protection); tests
  assert that `..` paths are rejected.

**Failure modes.**
- Daemon proxy upstream errors → response `{ "error": "daemon_<status>" }`
  with HTTP status forwarded; payload never includes the daemon's
  raw error string (avoid leaking internal paths).
- The static bundle is missing (`apps/inspector/web/dist/index.html`
  absent at boot) → server still starts but `GET /` returns
  503 with body `{"error":"frontend_bundle_missing"}`. This lets
  P4-inspector-frontend land independently.

### 2.4 Out of Scope

- WebSocket / SSE. Inspector polls; no real-time push.
- HTTPS / TLS termination. Loopback-only HTTP plus token.
- Multi-tenant / multi-token. Single token per process.
- LLM integration. The Inspector is a memory-tooling surface; it
  never calls a model.

## 3. Deferred

- Reverse-index optimization for graph queries (handled by core
  service, not Inspector).
- Inspector telemetry dashboards (out of v0.1).

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-inspector` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-inspector-server.md` exists and cites #BL-012 as partially closed |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Token middleware is constant-time and missing-token returns 401 | Auth tests assert both branches; timing-sensitive comparison call is verified by code inspection in review |
| AC8 | Bind to `127.0.0.1` only is enforced | Test asserts the listener does not respond on a non-loopback interface |
| AC9 | Frozen route surface contains exactly the table in §2.3 | Test enumerates registered routes and asserts the set equals the table |
| AC10 | The daemon-owned embedding-supplement PATCH writes `.env` atomically and never includes plaintext key in audit | Integration test seeds `<config-dir>/.env`, performs Inspector PATCH through the daemon proxy, asserts file contents are correct + audit row carries only the secret-ref string + response includes `requires_daemon_restart: true` |
| AC11 | Static handler rejects path traversal | Test asserts `GET /../../etc/passwd` returns 404 |
| AC12 | Missing frontend bundle does not crash the server | Test deletes `apps/inspector/web/dist/index.html`, asserts server starts and `GET /` returns 503 |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/inspector`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-inspector`

## 6. Shared File Hazards & Dependencies

- `apps/inspector/` is a brand-new package; no shared-file hazards
  inside the repo. Adding it to `pnpm-workspace.yaml` is in scope
  for this card.
- Workspace root `package.json`: this card MAY add the `inspector`
  to the workspace if not already present, but MUST NOT modify any
  unrelated root metadata. Single-line workspace addition is treated
  as a low-risk shared edit, not a barrel update.
- The `<config-dir>/.env` file is jointly owned by P4-cli-install
  (creator) and this card (PATCH path). Concurrent write protection
  is delegated to the shared helper in
  `apps/core-daemon/src/services/env-file-service.ts`, while secret-ref
  grammar and resolution remain owned by P4-secrets §2.3.

**Prerequisite**: P4-cli-bridge, P4-secrets, P4-routes-config, P4-routes-soul, P4-trust-state. P4-daemon-routes-register is a runtime prerequisite for the Gate-4 step-11 integration demo, not a code-level prerequisite for this card; the Inspector server can be implemented and unit-tested with a stub daemon before route registration lands.
**Blocks**: P4-cli-inspect, P4-inspector-frontend, Gate-4 demo (step 11).
