# Gate-5 Closeout — v0.1.0 Release Acceptance

Status: Gate-5 passed

Blocking: 0
Important: 0

## Scope

Gate-5 closes Phase 5 only:

- P5-graph-contract: schema-ready path graph contract derived from active
  PathRelation data.
- P5-e2e: live-event-ready release loop proving install, attach, MCP memory
  tools, CLI tools parity, candidate signal, proposal reject, Garden pass,
  status/doctor, backup, and export in one daemon lifetime.
- P5-final-review: four-perspective review and fix loop with zero Blocking /
  Important findings.

Benchmark work is Phase 6 / Gate-6 / v0.1.1 scope. Gate-5 did not execute or
claim benchmark harnesses, numbers, adapters, or README leaderboard output.

## Evidence

- `docs/v0.1/phase-5-briefs/reports/task-p5-graph-contract.md`
- `docs/v0.1/phase-5-briefs/reports/task-p5-e2e.md`
- `docs/v0.1/phase-5-briefs/reports/task-p5-final-review.md`
- `docs/v0.1/phase-5-briefs/reports/p5-final-review-perspective-a.md`
- `docs/v0.1/phase-5-briefs/reports/p5-final-review-perspective-b.md`
- `docs/v0.1/phase-5-briefs/reports/p5-final-review-perspective-c.md`
- `docs/v0.1/phase-5-briefs/reports/p5-final-review-perspective-d.md`

## Verification

Final decisive commands:

- `rtk pnpm install`
- `rtk pnpm build`
- `rtk pnpm test`
- `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon final-review`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon e2e gate4-attached-agent-mcp-proof operations mcp-memory-tool-handler mcp-memory-governance cli-register`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core graph-contract`
- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol soul-graph`
- `rtk pnpm exec vitest run --project @do-soul/alaya-storage proposal-repo`
- `rtk git diff --check`

All commands passed on 2026-05-02 in `p5-controller`. The full suite covered
245 test files and 1892 tests.

## Follow-Up

- `#BL-017` is now startable as a dedicated post-v0.1 hygiene wave.
- `#BL-024` tracks the broader HTTP proposal review transaction hardening risk.
- Phase 6 may start the v0.1.1 benchmark wave.
