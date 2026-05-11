# Do-SOUL Alaya v0.2 — Distributed Falcon

> Codename "distributed-falcon" is retained for continuity but the
> v0.2 scope is **NOT** multi-host distribution. v0.2 is single-host
> deepening: trustworthy recall, daemon-internal LLM via pi-mono, and
> end-to-end audit closure of the Trustworthy Memory Loop.

## What v0.2 is

v0.2 keeps invariant §21 intact (local-first memory plane; no chat UI,
no agent UI) and advances three threads:

1. **pi-mono enabler (#BL-008 close path).** The daemon's only LLM
   call point — `OfficialApiGardenProvider.requestSignals` — switches
   from a hand-rolled `fetch()` to a thin pi-mono extractor. The
   engine-gateway `ConversationProvider` placeholder column (never
   functional in v0.1) is retired in the same release because
   invariant §21 already disowned the chat-turn use case it modeled.

2. **Recall refinement.** Three measurable seams ship together:
   graduated budget penalty (replacing a hardcoded switch), token
   estimator hints carried in the `soul.recall` MCP input (degraded to
   the v0.1 char-per-token fallback when absent), and optional
   per-domain weight overrides on `RecallPolicy`.

3. **Trustworthy Memory Loop trace anchoring.** `source_delivery_ids`
   becomes an optional payload field on `soul.signal.emitted`,
   `soul.proposal.created`, and `soul.proposal.resolved`. An end-to-end
   audit test proves a single SQL JOIN over EventLog reconstructs the
   five-event chain (delivered → reported → emitted → created →
   resolved) using only `delivery_id`. Garden-originated signals omit
   the anchor by design and are surfaced as a distinct dashboard
   bucket.

The MCP and Protocol SemVer contract (invariant §25) is written in the
same release so sibling consumers can pin `@do-soul/alaya-protocol` to
the minor and follow without reading code.

## What v0.2 is not

- **Not** multi-host or multi-process distributed memory. The codename
  refers to single-host distribution between Garden roles and recall
  tiers, not network-level distribution.
- **Not** a memory-first agent product. A sibling memory-first agent
  is a separate parallel product to be evaluated using v0.1's recall
  utilization telemetry (`alaya status --recall-stats`); it lives in
  its own repository.
- **Not** any new user-facing surface (GUI, TUI, chat) — §21 forbids.
- **Not** an upstream fork of pi-mono. v0.2 consumes pi-mono as an npm
  dependency only.

## Release cadence

| Release | Scope | Cadence driver |
|---|---|---|
| **v0.2.0** | pi-mono enabler, recall refinement, Trustworthy Loop trace, §25 SemVer | Code-only; cadence controlled in-repo |
| **v0.2.1** | OS keychain adapter (#BL-009) | Three platform integrations |
| **v0.2.2** | Real host autonomy recording + offline replay (#BL-038); Codex `/alaya-inspect` host recognition (#BL-037) | External: needs real Codex/Claude run + Codex version handshake |

Splitting along cadence boundaries means v0.2.0 can ship on code merit
alone; v0.2.1 and v0.2.2 are dispatched independently when their
external dependencies allow.

## Forward compatibility commitment

v0.2.0 introduces invariant §25 (MCP and Protocol SemVer Contract).
Three concentric public contracts are covered:

- (a) MCP tool surface — tool names/descriptions plus every Zod
  schema *transitively reachable* from an MCP request/response type
  in `packages/protocol/src/soul/mcp-types.ts`, wherever those
  schemas live (the `semver-surface.test.ts` reachability snapshot is
  the authoritative inventory — no hand-maintained file list)
- (b) EventLog payload schemas (`packages/protocol/src/events/*`)
- (c) Runtime control-plane config schemas (`packages/protocol/src/app-config.ts`)

Additive changes (new optional fields, new event types, new tool
names) are minor bumps. Removals, renames, and semantic redefinitions
are major bumps. Deprecation requires a `@deprecated` JSDoc plus a
maintenance.md entry one minor before removal.

Sibling consumers (e.g. a future memory-first agent) pin
`@do-soul/alaya-protocol` to the minor (`^0.2.0`). Internal TypeScript
interfaces with no MCP / EventLog / config surface (e.g.
engine-gateway provider abstractions before any consumer exists) are
**out of SemVer scope** until a real production consumer surfaces.

## Layout

```
docs/v0.2/
├── README.md              ← this file (entry point)
├── v0.2.0/
│   ├── plan.md            ← v0.2.0 decisions + slice plan + risks
│   ├── release-notes.md   ← v0.2.0 shipped surface + follow-ups
│   ├── reports/
│   │   └── v0.2.0-closeout.md
│   └── task-cards/
│       ├── v0.2.0-slice-1-retire-conversation-provider.md
│       ├── v0.2.0-slice-2-pi-mono-extractor.md
│       ├── v0.2.0-slice-3-garden-provider-swap.md
│       ├── v0.2.0-slice-4-compute-provider-resolver.md
│       ├── v0.2.0-slice-5-budget-penalty-graduated.md
│       ├── v0.2.0-slice-6-token-estimator-hint.md
│       ├── v0.2.0-slice-7-per-domain-weights.md
│       ├── v0.2.0-slice-8-trust-loop-trace-anchors.md
│       ├── v0.2.0-slice-9-trust-loop-e2e-test.md
│       └── v0.2.0-slice-10-mcp-semver-25.md
├── v0.2.1/
│   └── plan.md            ← v0.2.1 keychain (#BL-009)
└── v0.2.2/
    └── plan.md            ← v0.2.2 host autonomy (#BL-037, #BL-038)
```

`v0.2.0/plan.md` is the operational plan; the ten task cards under
`v0.2.0/task-cards/` are the work units. v0.2.1 and v0.2.2 carry only
plan summaries; their task cards are written when each release becomes
the active wave.

## Cross-references

- `docs/handbook/invariants.md` — §21 (no agent UI), §25 (SemVer, new)
- `docs/handbook/backlog.md` — #BL-008 (closes in v0.2.0), #BL-009
  (v0.2.1), #BL-037 / #BL-038 (v0.2.2)
- `docs/handbook/runtime-status.md` — Subsystem readiness; updated as
  each slice lands
- `docs/handbook/workflow/agent-workflow.md` — per-card pipeline
- `docs/handbook/workflow/review-protocol.md` — review-loop discipline
  (Codex lens is mandatory at wave-end)
- `docs/handbook/task-card-template.md` — task-card format reference
