# Phase 4 — Wave 4: Daemon + Routes + Live Transport + CLI Bridge

Phase 4 lands the runtime body. Daemon entry, route registration, live
MCP transport (stdio + optional HTTP), real profile mutation (so
`alaya attach codex` actually writes Codex's config), CLI bridge
(actually executes daemon-side ops from the command line), and secret
ref resolution.

This is the phase that turns the v0.1 build from "compiles and tests
green" into "actually works for a user".

## Cards

| Card ID | Subject |
|---|---|
| P4-daemon-core | apps/core-daemon/src/{index,app,garden-runtime}.ts; daemon startup time-line; DI wiring |
| P4-routes-batch-1 | First batch of routes (8 routes) |
| P4-routes-batch-2 | Second batch of routes (8 routes) |
| P4-routes-batch-3 | Third batch of routes (8 routes) |
| P4-routes-batch-4 | Remaining routes |
| P4-mcp-server | Real MCP server transport (stdio + HTTP) so Codex / Claude Code can attach |
| P4-profile-mutation | Real profile file mutation (Codex `~/.codex/config.toml`, Claude Code `~/.claude/config.json` — preview + confirm enforced) |
| P4-cli-bridge | CLI commands actually call daemon (alaya doctor / install / attach codex / status) |
| P4-secrets | Secret ref resolution (env / local-file adapters; OS keychain deferred) |

## Gate-4 Acceptance

End-to-end demo:

1. `pnpm exec alaya install` succeeds.
2. `pnpm exec alaya attach codex` writes a preview, asks for
   confirmation, and on confirm writes the Codex config file.
3. From inside Codex, an MCP tool call to alaya writes a memory.
4. A second tool call retrieves the memory via recall.
5. Governance can reject a candidate (HITL flow visible).
6. Garden runs at least one background pass (Auditor) without
   blocking the foreground.
7. `pnpm exec alaya status` reports correct state.

All of the above must pass on a real daemon (not mocked).

Code-map and runtime-status updated.

## Parallelism Notes

- P4-daemon-core must land first; the route batches depend on it.
- P4-routes-batch-{1..4} can run in parallel after P4-daemon-core.
- P4-mcp-server can start in parallel with route batches.
- P4-profile-mutation, P4-cli-bridge, P4-secrets can run in parallel.

## Risks

This is the highest-risk phase because it integrates everything for
the first time. Any port discrepancy from Phase 1-3 will likely
surface here. Allocate time for a fix-loop pass.
