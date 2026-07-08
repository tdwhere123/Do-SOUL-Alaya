# Agent Workflow

Contributor loop for solo or small-PR work in Alaya. For the full
multi-card / phase-worktree pipeline retained from the v0.1 port era, see
`docs/archive/handbook-historical/workflow/agent-workflow-2026-07-full.md`.

## Pipeline

1. Read the PR brief, `.do-it/plans/` card, or get explicit user scope.
2. Read `docs/handbook/invariants.md` and any row-specific docs from the
   Task-Type table below.
3. Freeze scope — what files, what acceptance, what is out of scope.
4. For durable-state or MCP/CLI surface changes, trace producer → consumer
   before editing (`rg`, GitNexus).
5. Write or update tests first when practical.
6. Implement the smallest change that satisfies acceptance.
7. Verify: `rtk pnpm build` and targeted `rtk pnpm exec vitest run`.
8. Run `docs/handbook/workflow/review-protocol.md` on the diff before
   claiming done. Worker `DONE` is not acceptance.

## Anti-Tail (short)

- **R1** — One goal per change set; no silent scope expansion.
- **R2** — Deferrals cite a `#BL-NNN` row in `backlog.md`.
- **R3** — Do not mark gates passed without fresh verification evidence.
- **R4** — Re-review every fix loop before merge.
- **R5** — Bench / readiness claims need the witness named in
  `runtime-snapshot.md` or the task card.

## Task-Type Reading Matrix

| Task type | Minimum extra reads |
|---|---|
| Backend / runtime | `architecture.md`, `runtime-snapshot.md`, affected `backlog.md` rows |
| Protocol / schema | `invariants.md` §Contracts, `glossary.md` for touched terms |
| Docs only | Changed paths + `rg` for stale references to retired handbook files |
| Review | Diff, `invariants.md`, `review-protocol.md` |

## Stateful Mutation Checklist

Before merging changes that touch durable memory, EventLog, MCP tools, or
CLI attach state:

- [ ] EventLog-first ordering preserved (append → DB → audit → notify)
- [ ] No new SSE or GUI agent surface
- [ ] Governance change maps to a route family in `architecture.md`
- [ ] Tests cover the new producer and at least one consumer path

## Verification Defaults

```bash
rtk pnpm build
rtk pnpm exec vitest run --project @do-soul/alaya-<package>
```

Hygiene on Ubuntu CI path: `rtk pnpm run hygiene:unused` when touching
deps or exports.
