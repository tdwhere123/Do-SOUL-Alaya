# Gate-4 attached-agent MCP proof report

> Generated: 2026-05-01
> Authority: `docs/handbook/runtime-status.md` Gate-4 definition.

## What Ran

Fresh proof:

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon attached-agent-mcp-proof
```

Result: 1 file passed, 1 test passed.

The harness boots one daemon runtime with an isolated `DATA_DIR`,
`ALAYA_CONFIG_DIR`, `HOME`, and `CODEX_HOME`; starts daemon background
services without binding a TCP listener; attaches an MCP SDK client to
`createAlayaMcpServer()` through `InMemoryTransport`; and drives all
Gate-4 memory operations without spawning a second daemon.

## Transcript

| Step | Evidence |
|---|---|
| `alaya install --non-interactive --json` | OK; writes isolated config under the test `ALAYA_CONFIG_DIR`. |
| `alaya attach codex --yes --json` | OK; writes isolated Codex profile files and records installed/configured trust state. |
| MCP `tools/list` | Lists the full first-party `soul.*` catalog, including `soul.recall`, `soul.open_pointer`, `soul.report_context_usage`, `soul.emit_candidate_signal`, `soul.propose_memory_update`, and `soul.review_memory_proposal`. |
| `soul.recall` | OK; returns one seeded memory object and a `delivery_id` inside the same daemon lifetime. |
| `soul.open_pointer` | OK; opens the recalled memory object. |
| `soul.report_context_usage` | OK; records `usage_state=used` against the `delivery_id` from `soul.recall`. |
| `soul.emit_candidate_signal` | OK; emits a model-tool candidate signal for the attached-agent proof. |
| `soul.propose_memory_update` | OK; creates a governance proposal for the recalled memory object. |
| `soul.review_memory_proposal` | OK; rejects the proposal and returns `resolution_state=rejected`. |
| Garden background pass | OK; runs one deterministic Garden background pass inside the same daemon runtime and asserts Garden task dispatched/completed EventLog entries plus a Garden health-journal entry. |
| `alaya status --agent codex --json` | OK; reports `installed_count=1`, `configured_count=1`, `delivered_count=1`, `used_count=1`, `skipped_count=0`, `not_applicable_count=0`. |
| `alaya doctor --workspace workspace-1 --json` | OK; reports runtime ready, storage writable, MCP transport ready, and Garden healthy. |

## Closed Gap

The 2026-04-30 partial report proved `tools/list` and `soul.recall`, but
failed at `soul.report_context_usage` because each `alaya tools call`
spawned a fresh daemon process. That lost the in-process `delivery_id`
state.

This proof closes that gap by keeping one daemon runtime alive across
all MCP calls. The same `delivery_id` produced by `soul.recall` is
accepted by `soul.report_context_usage`, and `alaya status` observes the
resulting delivered/used counts.

## Related Repair

`#BL-015` addresses the durable version of the same failure mode for
delivery / usage records:

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon trust-state-persistence
```

That test proves runtime recall plus usage survives daemon restart and
keeps `alaya status --agent codex` delivery/usage counts stable. The
`#BL-015` issue is closed for delivery/usage durability; installed /
configured / unverifiable counter restart stability is closed separately
by `#BL-020` through EventLog replay before recorder readiness.

## Readiness

- `#BL-018` is resolved.
- The first-party MCP memory surface is `mcp-consumable` through the
  single-daemon MCP proof harness.
- Gate-4 passed after the `#BL-015` and `#BL-019` review fixes were
  verified.
- Superseded by the Phase 5 preflight: Gate-5 owns release-level E2E,
  graph contract, and final review. Benchmark work moved to Phase
  6 / Gate-6 / v0.1.1, and post-port hygiene starts only after Gate-5
  closes v0.1.0.
