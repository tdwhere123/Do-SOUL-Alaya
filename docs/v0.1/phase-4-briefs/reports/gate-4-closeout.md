# Gate-4 Closeout Status (2026-05-01)

> Gate definition: `docs/handbook/runtime-status.md §Gate Definitions Gate-4`.
> Primary proof: `reports/gate-4-mcp-proof.md`.

## Verdict

Gate-4 is **passed**. The single-daemon MCP proof harness resolves
`#BL-018`, Inspector config writes now proxy the daemon and resolve
`#BL-019`, and trust delivery/usage persistence resolves `#BL-015` for
delivery/usage records. Installed / configured / unverifiable counter
restart stability is closed by `#BL-020` through EventLog-backed startup
replay before recorder readiness.

| Close condition | State | Authority |
|---|---|---|
| Inspector surface live-event-ready | Closed 2026-05-01 | Inspector daemon proxy, EventLog audit, backend route tests, and web chip tests |
| Attached-agent MCP proof | Closed 2026-05-01 | `reports/gate-4-mcp-proof.md` |
| Paste-mode secret-ref repair | Closed 2026-05-01 | `#BL-019`, daemon config-route tests, Inspector routes, and `EmbeddingSupplementForm` tests |
| Trust delivery/usage restart durability | Closed 2026-05-01 | `#BL-015`, storage repo tests, migration parity, and `trust-state-persistence.test.ts` |
| Trust counter restart durability | Closed 2026-05-01 | `#BL-020`, EventLog-backed counter replay, and `trust-state-persistence.test.ts` |

## Fresh Evidence

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon gate4-attached-agent-mcp-proof
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon trust-state-persistence
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon routes-config-port app embedding-status trust-state trust-state-persistence gate4-attached-agent-mcp-proof
rtk pnpm exec vitest run --project @do-soul/alaya-inspector routes
rtk pnpm exec vitest run --project @do-soul/alaya-inspector-web EmbeddingSupplementForm
rtk pnpm exec vitest run --project @do-soul/alaya-storage trust-state-repo migration-parity
```

The proof harness runs `alaya install`, `alaya attach codex`, MCP
`tools/list`, `soul.recall`, `soul.open_pointer`,
`soul.report_context_usage`, `soul.emit_candidate_signal`, proposal
creation, governance reject, one Garden background pass, `alaya status`,
and `alaya doctor` in one daemon lifetime. The Garden step asserts
Garden task dispatched/completed EventLog entries and a Garden
health-journal entry.

## Backlog Changes

- `#BL-018` resolved: attached-agent MCP proof harness exists,
  exercises the cross-call delivery state, and asserts Garden evidence.
- `#BL-019` resolved: Inspector embedding supplement reads/writes proxy
  daemon truth, paste writes are hardened, and the daemon records the
  config write through EventLog.
- `#BL-015` resolved for delivery/usage persistence: SQLite rows survive
  daemon restart, duplicate records conflict instead of overwrite, and
  EventLog mutation rollback is covered.
- `#BL-020` resolved: installed/configured/unverifiable trust counters
  are replayed from EventLog before the recorder is marked ready.
- `#BL-013` resolved: `GreenService.setGrace()` emits
  `soul.green.grace_entered`.
- `#BL-014` remains open: this batch corrected a docs reference, but
  commit-history prevention still needs a future wave-close proof.
- `#BL-016` / `#BL-017` remain open and frozen until the final v0.1 port
  card lands.

## Remaining Release Work

Phase 5 is now unblocked by Gate-4. Superseded by the Phase 5
preflight: Gate-5 release work is the graph contract, full E2E loop, and
final review. The benchmark moved to Phase 6 / Gate-6 / v0.1.1.
