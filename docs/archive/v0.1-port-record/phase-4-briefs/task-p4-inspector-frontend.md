# Implementation Brief: Task P4-inspector-frontend — Memory Inspector SPA (Gemini-CLI authored)

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-inspector-frontend
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/inspector/web/package.json`, `apps/inspector/web/vite.config.ts`, `apps/inspector/web/tsconfig.json`, `apps/inspector/web/index.html`, `apps/inspector/web/src/main.tsx`, `apps/inspector/web/src/App.tsx`, `apps/inspector/web/src/api.ts`, `apps/inspector/web/src/pages/Config.tsx`, `apps/inspector/web/src/pages/Graph.tsx`, `apps/inspector/web/src/pages/Status.tsx`, `apps/inspector/web/src/components/*.tsx` (as needed by Gemini)
> - **Size**: M
> - **Prerequisite**: P4-inspector-server
> - **Blocks**: Gate-4 demo (step 11)
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned (Alaya owner reviews; **implementation delegated to Gemini CLI**)

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-inspector-frontend";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21` (narrowed 2026-04-29 to permit the
Memory Inspector as a memory-tooling surface) and `§24` (which lists
`inspector-frontend` as an Alaya-original `requires-redesign`
surface);
`docs/handbook/architecture.md §Surface Shape`.

## 1. Background & Goal

**Background**: The 3-page SPA that runs against
`@do-soul/alaya-inspector` (P4-inspector-server). It renders the
Provider/Config form, the Memory Graph viewer, and the Trust/Status
mirror, and it has *no other pages* and *no other write paths*. It
is the only visual surface Alaya ships in v0.1.

**Implementation handoff (explicit).** This card's frontend code is
written by **Gemini CLI**, not by an Alaya codex. The Alaya owner
authors this card (§0–§3 here), prepares the Gemini handoff prompt
in §2.3, executes the handoff, and reviews Gemini's output for the
contract requirements in §2.4. Gemini's output that fails the §2.4
gate is rejected and re-prompted; the Alaya owner does NOT
hand-write large portions of `web/src/` to "fix" Gemini output —
they refine the prompt and re-run. This handoff convention is
documented as the canonical pattern for any future Alaya UI cards.

**Goal**: A built `apps/inspector/web/dist/` bundle that, when
served by P4-inspector-server, lets a user complete the Gate-4
step-11 demo end-to-end (PATCH provider config; render the soul
graph; mirror `alaya status`).

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/inspector/web/package.json` | New SPA package; depends on `react`, `react-dom`, `vite`. No state-management library beyond React's built-ins unless Gemini's design justifies it in the handoff response. |
| `n/a` | `apps/inspector/web/vite.config.ts` | Vite build config; output to `apps/inspector/web/dist/`; base path `/`. |
| `n/a` | `apps/inspector/web/tsconfig.json` | Browser tsconfig. |
| `n/a` | `apps/inspector/web/index.html` | Single HTML entry. |
| `n/a` | `apps/inspector/web/src/main.tsx` | React entry. |
| `n/a` | `apps/inspector/web/src/App.tsx` | Router (3 pages); reads token from `?token=` URL param on first mount; stores in memory only (NEVER `localStorage` / `sessionStorage`). |
| `n/a` | `apps/inspector/web/src/api.ts` | Thin `fetch` wrapper that injects `X-Alaya-Inspector-Token` header. Handles `401` by prompting the user to re-run `alaya inspect`. |
| `n/a` | `apps/inspector/web/src/pages/Config.tsx` | Provider/Config page. |
| `n/a` | `apps/inspector/web/src/pages/Graph.tsx` | Memory Graph page. |
| `n/a` | `apps/inspector/web/src/pages/Status.tsx` | Trust/Status page. |
| `n/a` | `apps/inspector/web/src/components/*.tsx` | As needed by Gemini's design; reviewer ensures each is in service of one of the three pages. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md §3` for that mode.
- All HTTP calls go through `web/src/api.ts`. Pages MUST NOT call
  `fetch` directly.
- No imports from `@do-soul/alaya-core`, `@do-soul/alaya-storage`,
  or any other Alaya runtime package. The frontend is a pure HTTP
  client of the Inspector server. The only Alaya import allowed is
  `@do-soul/alaya-protocol` for type-only imports (zod schemas
  reused for client-side validation if Gemini chooses).
- If a cited source path is missing or the Gemini handoff requires
  files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Gemini CLI Handoff

The Alaya owner runs `gemini` with a handoff prompt that includes,
verbatim, the following contract block. Gemini's first response
MUST contain a complete file tree for `apps/inspector/web/`; the
Alaya owner saves Gemini's output and runs §5 verification. If
verification fails, the Alaya owner re-prompts with the specific
failure rather than hand-editing.

**Gemini handoff contract (paste verbatim into the prompt).**

```
You are writing the frontend SPA at apps/inspector/web/ for the
Alaya Memory Inspector. Constraints:

1. THREE PAGES, NOTHING ELSE. The router has exactly:
   - /config        → Provider / runtime config (read + write)
   - /graph         → Memory graph (read-only visualization)
   - /status        → Trust state + Garden status (read-only)
   Default route redirects to /config.

2. AUTH. Token comes from the ?token= URL query parameter on first
   load. Store it in memory only (React state); never localStorage
   or sessionStorage. Every fetch sets X-Alaya-Inspector-Token.

3. API. Talk to the same-origin Inspector server at /api/...
   See the route table at apps/inspector/src/routes/* for the exact
   shapes. Use react-query OR plain useEffect; choose one and
   document the choice. No SSE / WebSocket — polling only, max
   every 5 seconds, only on the active page.

4. CONFIG PAGE.
   - Form fields driven by SoulConfig / StrategyConfig /
     EnvironmentConfig zod schemas from @do-soul/alaya-protocol.
   - Separate sub-form for embedding-supplement (provider URL,
     model id, API key secret-ref source: env / file / paste).
     The "paste" option warns the user the value will be written
     to <config-dir>/secrets/openai with mode 0600 and shows the
     resulting secret-ref before confirm.
   - PATCH submits return { requires_daemon_restart: true }; the
     UI MUST display a "Restart daemon" banner that links to a
     copy-pasteable shell command. It MUST NOT auto-restart.

5. GRAPH PAGE. Renders the SoulGraph payload as a node-link graph.
   Library choice is open (d3, react-flow, vis-network, etc.) but
   the dependency MUST be justified in package.json with a comment
   line. Read-only: clicking a node opens a detail drawer; no
   editing. The drawer's "open in CLI" button copies a CLI command
   like `alaya tools call --json soul.open_pointer ...` to the
   clipboard.

6. STATUS PAGE. Read-only mirror of `alaya status`. No actions.

7. NO. Do NOT add: chat UI, agent simulation, memory CRUD, governance
   approval buttons (those go through the engine per the user
   decision 2026-04-29), telemetry, analytics, third-party fonts
   loaded from CDN, or any external network call other than to
   /api/... on the same origin.

8. STYLE. Tailwind allowed if needed. The visual identity is
   "diagnostic console", not "consumer app". Dense, monospace-
   friendly, minimal animation.

9. SIZE BUDGET. Built bundle gzipped MUST be < 500 KB. If a graph
   library pushes the budget, propose a smaller alternative before
   submitting.
```

After Gemini's submission, the Alaya owner runs `pnpm build` inside
`apps/inspector/web/` and confirms the size budget; if it fails, the
owner re-prompts with the specific size delta.

### 2.4 Reviewer Gate (Alaya owner review of Gemini output)

The Alaya owner approves Gemini's output ONLY if all of the
following hold. Anything that fails sends the work back to Gemini
with the specific failure quoted:

| Gate | Check |
|---|---|
| G1 | The router has exactly three routes (`/config`, `/graph`, `/status`) plus a default redirect. Reviewer greps the App.tsx. |
| G2 | The token is read from `?token=` and stored in React state only. Reviewer greps for `localStorage` / `sessionStorage`; both must return zero hits. |
| G3 | All `fetch` calls go through `web/src/api.ts`. Reviewer greps `fetch(` in `web/src/`; only one hit allowed (inside `api.ts`). |
| G4 | No memory-CRUD UI. No "create memory" / "delete memory" / "edit memory" component, button, or route. Reviewer greps for `propose_memory_update`, `apply_override`, `governance` in TSX files; expected zero hits (those flows go through the engine per the 2026-04-29 decision). |
| G5 | No external CDN font / script / image. Reviewer greps `https://` in TSX/CSS; only Alaya-internal references allowed. |
| G6 | Gzipped bundle < 500 KB. Reviewer runs `pnpm build` and inspects `dist/assets/*.js`. |
| G7 | The PATCH-config flow surfaces the `requires_daemon_restart: true` banner. Reviewer exercises the path manually against a stub server and screenshots. |
| G8 | The Graph page is read-only. Reviewer attempts to drag-edit / right-click-edit a node; both must be no-ops. |

### 2.5 Out of Scope

- Adding any page beyond the three named routes.
- Any direct call to daemon HTTP routes (must go through Inspector
  server `/api/...`).
- Bundling LLM provider clients into the frontend.
- Authoring extra HTTP routes on the server side; if Gemini needs a
  new route, the request goes back to P4-inspector-server as a
  separate follow-up card, not added here.

## 3. Deferred

- Polish, accessibility audit, i18n. These are real concerns but
  out of v0.1 (Inspector v0.1 is "diagnostic console", not consumer
  product). No backlog issue yet because the v0.1 bar is "the
  Gate-4 demo step 11 passes".
- Telemetry / analytics. Out of scope permanently per invariant §21
  (no agent surface; no consumer-app instrumentation).

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Reviewer Gate §2.4 passes; targeted tests from §5 pass |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm --filter @do-soul/alaya-inspector-web build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-inspector-web` (component-level smoke tests Gemini ships) |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-inspector-frontend.md` exists, includes the exact Gemini handoff prompt used and the iteration count, and cites #BL-012 as fully closed by this card landing |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Reviewer Gate §2.4 G1–G8 all pass | Reviewer fills a Gate checklist in the completion report |
| AC8 | Backlog #BL-012 status flips to Resolved on close | `docs/handbook/backlog.md` updated in the same PR / commit window |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm --filter @do-soul/alaya-inspector-web build`
4. `rtk pnpm exec vitest run --project @do-soul/alaya-inspector-web`
5. End-to-end smoke against P4-inspector-server: serve the built
   bundle, navigate to `/config`, PATCH a SoulConfig field, assert
   the `requires_daemon_restart` banner appears.

## 6. Shared File Hazards & Dependencies

- `apps/inspector/web/` is brand-new; no in-repo shared-file
  hazards.
- Workspace root `pnpm-workspace.yaml` may need an entry; treat as
  low-risk single-line addition (or piggyback on the
  `apps/inspector` entry P4-inspector-server adds).
- The frontend depends only on `@do-soul/alaya-protocol` from the
  Alaya monorepo. Importing from `@do-soul/alaya-core` or
  `@do-soul/alaya-storage` is forbidden and is checked in §2.4 G3
  by reviewer grep.

**Prerequisite**: P4-inspector-server.
**Blocks**: Gate-4 demo (step 11 final).
