# Gate-4 Non-Frontend Closeout Report

## Scope

This report closes the Codex-owned, non-frontend Phase 4 surface:
core daemon, daemon routes, middleware, runtime wiring, daemon helper
services, MCP tooling, first-party MCP memory tools, MCP server
transport, CLI bridge, install / attach / detach / inspect / status /
doctor / tools / operations commands, secrets, trust state, global
recall cache invalidation, and the Inspector server.

Out of scope: `P4-inspector-frontend`. The frontend card remains
unimplemented and is still delegated to Gemini CLI by its task card.
This report therefore did not claim Gate-4 passed at the time.

2026-05-01 amendment: the frontend card, attached-agent MCP proof,
trust delivery/usage persistence repair, and Inspector daemon-proxy
config repair have since landed. Current Gate-4 status lives in
`reports/gate-4-closeout.md` and `reports/gate-4-mcp-proof.md`; Gate-4
passed after `#BL-015` and `#BL-019` were verified.

Historical baseline: `review-p4-controller.md` remains the failure
report for the previous controller implementation. The recovery work
removed the rejected `daemon-handle.ts` / `daemon-service-graph.ts`
facade pattern and re-established typed route-service injection,
Hono middleware, ported daemon helper modules, and explicit startup
composition.

## Readiness

Phase 4 non-frontend status: `implementation-ready`.

Gate-4 status at the time of this report: pending.

Remaining Gate-4 closure work:

- `P4-inspector-frontend`.
- Attached-agent proof that `tools/list` exposes the complete
  `soul.*` catalog and that the memory-tool flow works through a real
  daemon.
- Final review pass with zero Blocking / Important findings.

## Commit Evidence

- `414a337 docs(p4): harden recovery card scopes`
- `7813749 feat(p4-daemon): add daemon foundation package`
- `db6a38e feat(p4-daemon): port core daemon runtime graph`
- `b61c630 feat(p4-foundation): add trust state cli bridge and secrets`
- `cc6d933 feat(p4-cli-mcp): add memory tools and operator cli`
- `d76e5ef feat(p4-inspector): add backend inspector and inspect cli`
- `4b48f26 fix(p4-cli-inspect): gate fixed inspector tokens`

## Fresh Verification

All checks run from
`/home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p4-recovery-controller`.

- `rtk pnpm install` - passed.
- `rtk pnpm exec tsc -b packages/protocol` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/protocol` - passed.
- `rtk pnpm exec tsc --noEmit -p apps/core-daemon` - passed.
- `rtk pnpm exec tsc --noEmit -p apps/inspector` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol app-config` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-inspector` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli inspect"` - passed after the fixed-token env-gate fix.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm test` - passed.
- `rtk rg -n "daemon-service-graph|daemon-handle|Promise<unknown>|context\\.daemon|DaemonRouteHandler" apps/core-daemon/src apps/inspector/src` - no matches.

## Review And Fix Loop

The old `review-p4-controller.md` findings were used as the recovery
checklist. The major Blocking classes were closed by replacing the
custom daemon facade with typed Hono route-service injection, porting
daemon services / glue / middleware / MCP tooling as separate modules,
and wiring runtime notifier / startup composition through
`apps/core-daemon/src/index.ts`.

CLI Important findings were closed by adding bridge-level attach tests,
detach tests, audit-first profile and operations paths, install
confirm/audit behavior, and the `cli inspect --token` env gate in
`4b48f26`.

Inspector server Blocking finding `B-INSPECTOR-1` was closed by
exporting runtime embedding config / `AlayaStatus` schemas and wiring
daemon `PATCH` support for `embedding_enabled` through the Inspector
server contract.

No frontend review is claimed here.

## Residual Risk

2026-05-01 amendment: `P4-trust-state` delivery/usage records have a
SQL-backed persistence path, and `#BL-015` is resolved for
delivery/usage durability. Installed/configured/unverifiable counters
remain in-process and are tracked separately by `#BL-020`.

`P4-inspector-frontend` landed, and Inspector config-write live
readiness is closed by `#BL-019`.
