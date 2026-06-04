# Completion Report — Task P4-inspector-frontend

> Card: `docs/v0.1/phase-4-briefs/task-p4-inspector-frontend.md`
> Closing readiness label: `live-event-ready`
> Backlog: #BL-012 → Resolved (this card)
> Generated: 2026-04-30

## Source files (target tree)

| Path | Mode | Notes |
|---|---|---|
| `apps/inspector/web/package.json` | new / patched | switched from monolithic `d3` to `d3-force` / `d3-selection` / `d3-drag` / `d3-zoom`; added `@do-soul/alaya-protocol` workspace dep (type-only); added `vitest` + `@testing-library/react` + `jsdom` for AC4 |
| `apps/inspector/web/vite.config.ts` | patched | manualChunks: `vendor` (react+router) and `d3` (4 d3 sub-packages) |
| `apps/inspector/web/vitest.config.ts` | new | jsdom env + `@/` alias + `@do-soul/alaya-protocol` source alias |
| `apps/inspector/web/src/test/setup.ts` | new | RTL cleanup + vi.restoreAllMocks afterEach |
| `apps/inspector/web/src/main.tsx` | unchanged | React entry (Gemini-shipped) |
| `apps/inspector/web/src/App.tsx` | rewritten | adds `setUnauthorizedHandler` → `<SessionExpired/>`; mounts `<ToastProvider>` once |
| `apps/inspector/web/src/api.ts` | rewritten | type-only protocol imports; GET/HEAD 5xx retry-once exp backoff; global 401 callback |
| `apps/inspector/web/src/pages/Config.tsx` | rewritten | dirty-state per section; beforeunload warning; restart banner with daemon-restart copy command + dismiss; embeds EmbeddingSupplementForm |
| `apps/inspector/web/src/pages/Graph.tsx` | rewritten | spotlight 3-tier (match / adjacent 1-hop / background) via CSS data-state; Paper Overlay drawer; "/", Cmd/Ctrl+K, ↑↓ shortcuts; "Open in CLI" → `soul.open_pointer` clipboard; G8 read-only (no drag-edit, no contextmenu) |
| `apps/inspector/web/src/pages/Status.tsx` | rewritten | daemon.ready→indicator (OPERATIONAL/WARMING/OFFLINE) fixes prior misread bug; `AlayaStatusSchema.safeParse` fallback; manual refresh w/ 1s cooldown; failure backoff 30s; one-shot Toast (no spam) |
| `apps/inspector/web/src/pages/components/EmbeddingSupplementForm.tsx` | new | env:/file: prefix chips; UPPER_SNAKE_CASE env validation on blur; absolute-path validation for file:; eye toggle to mask file paths; PATCH `/api/config/runtime/embedding-supplement` triggers banner |
| `apps/inspector/web/src/components/Layout.tsx` | rewritten | flex-wrap nav; icon-only collapse <640px (no hamburger per spec) |
| `apps/inspector/web/src/components/Toast.tsx` | rewritten | real React Context provider; max 3 visible (FIFO); 2s message dedup |
| `apps/inspector/web/src/components/SessionExpired.tsx` | new | full-screen 401 surface; mirrors AUTH_MISSING_TOKEN visual |
| `apps/inspector/web/src/index.css` | patched | spotlight `data-state` CSS rules with 250ms transitions |
| `apps/inspector/web/scripts/gate-check.sh` | new | grep-based G2/G3/G4/G5 self-check (AC §2.4) |
| `apps/inspector/web/src/api.test.ts` | new | 5 cases — header inject, workspaceId interp, 401 → ApiError + global handler, GET 5xx retry, PATCH no retry |
| `apps/inspector/web/src/pages/Config.test.tsx` | new | dirty indicator green↔amber, restart banner after PATCH |
| `apps/inspector/web/src/pages/Graph.test.tsx` | new | spotlight 3-state, clear-search recovery, click → drawer + clipboard CLI, contextmenu no-op |
| `apps/inspector/web/src/pages/Status.test.tsx` | new | OPERATIONAL/OFFLINE indicator, schema mismatch fallback, degraded banner on failure |
| `apps/inspector/web/src/pages/components/EmbeddingSupplementForm.test.tsx` | new | env: plaintext, file: mask + reveal, UPPER_SNAKE_CASE validation |
| `vitest.workspace.mjs` | patched | references `apps/inspector/web/vitest.config.ts` |

## Port mode

`requires-redesign` (Alaya original; `docs/handbook/invariants.md §24`).
No `vendor/do-what-new-snapshot/` source to compare. Visual contract
follows `docs/superpowers/specs/2024-05-20-ink-ui.md`.

## Gemini handoff prompt (verbatim, used by ui-ink commit `f1e5372`)

```
[See task-p4-inspector-frontend.md §2.3 — the prompt was used as-is. The
two Gemini-generated variants (feat/ui-orbs and feat/ui-ink) were
reviewed by the owner and ui-ink ("Ink & Fiber") was selected on
2026-04-30 as best aligning with the docs/superpowers spec.]
```

Iteration count: 1 generation (ink variant) + 1 follow-up rewrite pass on
the owner side to satisfy AC1–AC8 (this report's diff).

## Reviewer Gate §2.4 G1–G8 checklist

| Gate | Check | Evidence | Result |
|---|---|---|---|
| G1 | Router has exactly 3 routes (`/config`, `/graph`, `/status`) + default redirect | `App.tsx:74-83` shows 3 `<Route>` + 1 `<Navigate to="/config" replace/>` | ✅ |
| G2 | Token in React state only; no localStorage / sessionStorage | `bash apps/inspector/web/scripts/gate-check.sh` step G2: `✓ pass`. `api.ts` stores `inspectorToken` in module-private mutable; `App.tsx` reads from `?token=` and calls `setInspectorToken` (no persistence) | ✅ |
| G3 | Every fetch goes through `web/src/api.ts` | gate-check.sh G3: `✓ pass`; only `api.ts` calls `fetch(`, all pages call `apiFetch` | ✅ |
| G4 | No memory-CRUD UI / governance approve buttons | gate-check.sh G4: `✓ pass`. Zero hits for `propose_memory_update`/`apply_override`/`governance` in `src/**/*.tsx` | ✅ |
| G5 | No external CDN font / script / image | gate-check.sh G5: `✓ pass (only placeholders / docs URLs)`. Only `https://api.openai.com/v1` placeholder text and a doc URL pointing to react-router future flags warning | ✅ |
| G6 | Built bundle gzipped < 500 KB | `pnpm --filter @do-soul/alaya-inspector-web build` total per-asset gzipped: index 57.7 KB + vendor 53.7 KB + d3 21.5 KB + index.css 4.7 KB + index.html 0.4 KB ≈ **138 KB**. **Budget: 500 KB. Headroom: 72 %.** | ✅ |
| G7 | PATCH-config flow surfaces `requires_daemon_restart` banner | RTL test `Config.test.tsx > shows restart banner after PATCH that returns requires_daemon_restart` passes; banner is sticky (no auto-dismiss timer); copy-command button + manual dismiss; covers both Soul/Strategy/Environment and Embedding flows | ✅ |
| G8 | Graph page is read-only | RTL test `Graph.test.tsx > ignores contextmenu` passes; no drag-edit handlers; SVG `onContextMenu={(e)=>e.preventDefault()}`; click only opens detail drawer (read-only) | ✅ |

**G1–G8: 0 fail / 0 partial / 8 pass.**

## Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All §2 behaviors implemented | Reviewer Gate §2.4 8/8; targeted tests pass |
| AC2 | All cited source paths exist | `bin/alaya.mjs doctor --json` validates daemon paths; web target paths under `apps/inspector/web/` all present |
| AC3 | Build succeeds | `rtk pnpm --filter @do-soul/alaya-inspector-web build` exits 0 (`built in 2.98s`) |
| AC4 | Targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-inspector-web` → **18 passed** in 5 files |
| AC5 | Completion report present | this file; cites #BL-012 closure |
| AC6 | Closing label `live-event-ready` | `docs/v0.1/INDEX.md` and `docs/handbook/runtime-status.md` flipped in same commit window (Step 4 of plan) |
| AC7 | §2.4 G1–G8 all pass | see Gate table above |
| AC8 | #BL-012 → Resolved | `docs/handbook/backlog.md` updated in same commit window |

## Findings (Review Finding Records)

No Blocking. No Important. No Nice-to-have under in-card scope.

Note: a separate finding raised by the MCP-proof phase
(`reports/gate-4-mcp-proof.md`) recommends **#BL-018 — attached-agent MCP
proof harness**; that is OUT OF SCOPE for this card per §2.5 (forbids
new server-side routes / harnesses).

2026-05-01 update: `#BL-018` is resolved by
`attached-agent-mcp-proof.test.ts`.

## Deviations from card §2.3 prompt

1. **secret_ref `paste` mode originally deferred, then repaired** — card
   §2.3 #4 mentioned a "paste" secret-source. The first frontend landing
   exposed env/file only, so backlog `#BL-019` tracked the missing paste
   pipeline. The 2026-05-01 repair moved embedding-supplement config
   truth to the daemon: Inspector now proxies GET/PATCH to daemon routes,
   paste writes produce a sanitized `file:` ref, the daemon records the
   write through EventLog, and the frontend exposes env/file/paste chips.
2. **react-router `useBlocker`** — card permitted "react-query OR plain
   useEffect; choose one and document the choice." This SPA uses plain
   `useEffect` + `<BrowserRouter>`. `useBlocker` requires data-router
   variant; instead, dirty in-page navigation is guarded by
   `beforeunload` (covers tab close/refresh) and Toast warnings. In-app
   route changes do NOT prompt — accepted limit, since the SPA has only
   3 routes and the user can always re-edit.

## Verification commands re-run during this report

```
$ rtk pnpm --filter @do-soul/alaya-inspector-web build
✓ built in 2.98s
$ rtk pnpm exec vitest run --project @do-soul/alaya-inspector-web
Test Files  5 passed (5) | Tests 18 passed (18)
$ rtk pnpm exec vitest run --project @do-soul/alaya-inspector
Test Files  2 passed (2) | Tests 8 passed (8)
$ bash apps/inspector/web/scripts/gate-check.sh
[gate-check] PASS — Reviewer Gate G2/G3/G4/G5 all green
```

## Closing label

`live-event-ready` (this card alone). At report time, Gate-4 itself was
pending until #BL-018 (attached-agent MCP proof harness) landed; see
`reports/gate-4-mcp-proof.md`.

2026-05-01 update: #BL-019 paste mode and #BL-018 attached-agent proof
have both landed. Gate-4 is closed by `reports/gate-4-closeout.md`.
