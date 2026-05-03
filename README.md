# Do-SOUL Alaya

> A local-first memory core for CLI agents. Port of the memory plugin
> system from `do-what-new`.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-local-003B57?logo=sqlite&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

## What it is

Do-SOUL Alaya is the memory plane that CLI coding-agents — Codex, Claude
Code, and similar — attach to over MCP or via the `alaya` CLI. It has
**no agent-frontend GUI and no conversation TUI**. The only Alaya-side
UI is the **Memory Inspector**, a loopback memory-tooling SPA started on
demand via `alaya inspect`; it is strictly a memory-management surface
and never participates in agent control flow. Alaya is the long-term
governed memory that sits next to whatever agent the user is actually
talking to.

Capabilities (target for v0.1):

- evidence-backed memory ontology with durable-truth gating
- governed promotion (HITL, Promotion Gate, Green status state machine)
- multi-path recall (lexical / FTS / path-aware / embedding supplement)
- session trust audit (delivered ≠ used invariant)
- Garden self-maintenance (Auditor / Janitor / Librarian + Scheduler)
- MCP server surface + plain CLI fallback
- profile / secret / import-export / portable backup operations

## Architecture

```text
External CLI agent (Codex / Claude Code / ...)
  → attaches via MCP, optional CLI fallback
  → talks to Alaya core daemon over MCP transport (stdio or HTTP)

Alaya Core Daemon (apps/core-daemon)
  → wires the core runtime
  → owns workspace / run / config / file routes
  → exposes the MCP tool surface

Core Runtime (packages/core)
  → MemoryService / EvidenceService / RecallService
  → GreenService / GovernanceLeaseService / SessionOverrideService
  → ConversationService / SignalService
  → OutputShaping / NarrativeBudget / ManifestationResolver
  → Security defense stack (PermissionPolicy / WorkerSafety / Stance)

SOUL Kernel + Garden (packages/soul)
  → Auditor (evidence staleness, orphan radar, pointer healing)
  → Janitor (hot/cold demotion)
  → Librarian (path compaction)
  → GardenScheduler (fire-and-forget background work)

Storage (packages/storage)
  → SQLite via better-sqlite3, ~55 ordered migrations
  → 30+ Repos behind a single SqliteConnection contract

Engine Gateway (packages/engine-gateway)
  → provider adapters (openai / anthropic / custom)
  → routing only, no business logic

Protocol (packages/protocol)
  → zod-only leaf; all domain types
```

SOUL three-layer model (same as upstream):

| Layer | Purpose | Key objects |
|---|---|---|
| Memory Ontology | What is remembered long-term | `EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule`, `ClaimForm` |
| Structure Registry | How objects are located and bound | `PathRelation`, `ActivationCandidate`, `ManifestationDecision` |
| Runtime Control Plane | How memory is assembled per turn | `RecallQuery`, `ContextPack`, `TrustSummary` |

## Source Provenance

This repository is a **port** of the memory subsystem of `do-what-new`,
not a clean-room rewrite. The frozen upstream snapshot lives at
`vendor/do-what-new-snapshot/` (see `SNAPSHOT_REF.md` for the source
commit hash and stability assurance).

Per the project context (2026-04-28): upstream `do-what-new` may
continue to iterate on UI / surface code, but its memory subsystem is
not currently scheduled for further iteration, so this snapshot is
expected to remain a stable port surface.

## Status

- **v0.1.0** released (Gate-5 passed 2026-05-02). The MCP tool surface
  is `mcp-consumable`, the release E2E loop is `live-event-ready`, and
  the multi-lens final review closed with zero Blocking / Important
  findings. A subsequent system-level review (`p5-system-review-r1`,
  2026-05-03) is in fix-loop; see
  `docs/v0.1/phase-5-briefs/reports/p5-system-review-round-1.md`.
- **v0.1.1** is post-release (Phase 6 marketing benchmark wave; not
  started). It is not a v0.1.0 blocker.
- Detailed status: `docs/v0.1/INDEX.md`,
  `docs/handbook/runtime-status.md`, `docs/handbook/backlog.md`.

## Audience

Engineers running a CLI coding-agent (Codex, Claude Code, or similar).
Alaya is not a chat product; you do not talk to Alaya, the agent does.
Setup requires Node 20+, pnpm, and a working CLI agent.

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | >= 20 |
| pnpm | >= 9 |

## Quick start

All `alaya` subcommands require a prior `rtk pnpm build` (the shim
loads compiled output from `apps/core-daemon/dist/`). Re-run after any
source change.

```bash
rtk pnpm install
rtk pnpm build
rtk pnpm test
```

CLI surface (post Gate-4 / Gate-5):

```bash
rtk pnpm exec alaya doctor                            # diagnostic
rtk pnpm exec alaya install                           # install profile
rtk pnpm exec alaya attach codex                      # attach Codex
rtk pnpm exec alaya attach claude-code                # attach Claude Code
rtk pnpm exec alaya detach codex                      # reverse attach
rtk pnpm exec alaya status                            # daemon + trust state
rtk pnpm exec alaya inspect                           # Memory Inspector loopback (memory-tooling surface, not an agent surface)
rtk pnpm exec alaya tools list                        # list MCP memory tools
rtk pnpm exec alaya tools call soul.recall '<json>' --json   # call one tool
rtk pnpm exec alaya backup --output <path>            # portable bundle
rtk pnpm exec alaya export --output <path>            # portable export
rtk pnpm exec alaya import --bundle <path>            # restore from bundle
rtk pnpm exec alaya mcp stdio                         # daemon MCP stdio server
```

## Architecture invariants

Key invariants (full set in `docs/handbook/invariants.md`):

- `packages/protocol` is the domain leaf and depends only on `zod`
- All domain types come from `@do-soul/alaya-protocol`
- Core runtime (`packages/core`, wired by `apps/core-daemon`) is the
  truth boundary
- Storage owns mechanical persistence behind core; storage does not
  decide truth
- State changes follow EventLog → DB update → broadcast
- Garden maintenance stays fire-and-forget relative to the main
  request path
- Embedding is a recall supplement; it never decides durable truth
- LLMs and connected agents propose candidates; Alaya decides durable
  truth
- Alaya has no agent-frontend GUI and no conversation TUI; agent
  surfaces are MCP and the `alaya` CLI. The Memory Inspector is a
  separate memory-tooling loopback surface, not an agent surface.

## Docs map

- `docs/handbook/README.md` — maintained documentation entry point
- `docs/handbook/architecture.md` — stable architecture overview
- `docs/handbook/invariants.md` — architecture rules
- `docs/handbook/port-protocol.md` — Port-First discipline
- `docs/handbook/code-map.md` — current implementation map
- `docs/handbook/runtime-status.md` — current wiring status and known
  gaps
- `docs/v0.1/INDEX.md` — active v0.1 task-card index
- `docs/handbook/backlog.md` — unresolved issues
- `vendor/do-what-new-snapshot/` — frozen upstream source reference

## License

MIT
