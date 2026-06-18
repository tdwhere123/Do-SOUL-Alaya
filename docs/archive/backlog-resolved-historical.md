# Backlog — Resolved Issues (Historical Archive)

This file preserves resolved backlog entries removed from
`docs/handbook/backlog.md` on 2026-06-18 to keep the handbook concise.
Open issues and permanently rejected items remain in the handbook backlog.

---

## Resolved in v0.3.11

### #BL-049 — Forgetting-lifecycle compress arm activated

**Status**: Resolved (closed in the v0.3.11 closeout fix-loop, 2026-06-04).

The compress arm is now ARMED. All three activation gates were met: (1) `source_memory_refs` producer wired; (2) compress-vs-protection ordering fixed; (3) lossy-summary-preservation documented honestly. Full details in the closeout evidence chain (`5ab7f768`, `fe49ad98`, `3155cf1d`, etc.).

### #BL-050 — Ingest reconciliation default-ON under zero-own-LLM

**Status**: Resolved (closed in the v0.3.11 closeout fix-loop, 2026-06-04).

D-F1 ingest reconciliation runs out of the box on a rule-only, zero-cloud basis. Byte-equal duplicate → NOOP; ambiguous band → ADD. Cloud garden-LLM is optional and default-OFF. `ALAYA_INGEST_RECONCILIATION_ENABLED=0` disables entirely. Close evidence: `d57ace8a`, `90ba64a9`.

### #BL-055 — Inspector Health Inbox path-relation-failure label/filter

**Status**: Resolved on `audit/full-repair-2026-06-14`.

The Inspector Health Inbox now treats `path_relation_failure` as a first-class cause kind with dedicated English and Chinese labels and test coverage.

### #BL-056 — Token-savings ratio as a benchmark-harness contract (LoCoMo gap)

**Status**: Resolved (LoCoMo bench verified 2026-06-08).

The token-economy savings metric is now a harness-level contract (`assertBenchTokenEconomyContract` in `apps/bench-runner/src/harness/token-economy.ts`) satisfied by every integrated benchmark.

---

## Resolved in v0.3.8

### #BL-039 — Wire real embedding provider into recall path

**Status**: Resolved in v0.3.8. `OpenAIEmbeddingClient` confirmed working against yunwu.ai `/v1/embeddings` (text-embedding-3-small, 1536-d).

### #BL-040 — Scale LongMemEval-S smoke to confidence-interval sample

**Status**: Resolved in v0.3.8. Wilson CI added via `packages/eval/src/metrics/wilson-ci.ts`; report annotates R@K with half-width and lo/hi bounds.

### #BL-041 — LoCoMo cross-stack comparison

**Status**: Resolved in v0.3.8. `apps/bench-runner/src/locomo/` ships dataset schema, sha256-pinned fetcher, and runner. First archive under `docs/bench-history/public-locomo/`.

### #BL-042 — Inspector Memory Browser + command palette

**Status**: Resolved in v0.3.8. `MemoryBrowser.tsx` and `CommandPalette.tsx` shipped.

### #BL-045 — PathRelationProposalService counter eviction port

**Status**: Resolved in v0.3.8. `evictExpired` exposed; daemon wires unref'd setInterval with `ALAYA_PATHREL_COUNTER_TTL_MS`.

### #BL-046 — ConflictDetectionService rule-path disable toggle

**Status**: Resolved in v0.3.8. `ruleEnabled` constructor option; daemon reads `ALAYA_CONFLICT_RULE_ENABLED`.

---

## Resolved in v0.3.6

### #BL-043 — tool-runtime-bootstrap.test.ts port-3000 parallel flake

**Status**: Resolved in v0.3.6 (commit `b8fce04`). Changed to `port: 0` for OS-assigned free port.

---

## Resolved in v0.3.0

### #BL-037 — Codex `/alaya-inspect` host recognition proof

**Status**: Resolved in v0.3.0 (negative proof). Codex CLI 0.130.0 does not expose a third-party fixed slash-command registry.

### #BL-038 — Host autonomous use of `soul.*` tools

**Status**: Resolved in v0.3.0 (live-usage witness). `scripts/export-host-autonomy-witness.mjs` exports real usage chains; `host-autonomy-witness.test.ts` pins them offline.

---

## Resolved by v0.2.0

### #BL-008 — engine-gateway provider integration via pi-mono

**Status**: Resolved in v0.2.0. `OfficialApiGardenProvider` → pi-mono through `pi-mono-extractor.ts`.

---

## Resolved by Gate-5F (2026-05-05)

- **#BL-025** — EventPublisher input revision removed
- **#BL-026** — Legacy EventPublisher mutation APIs removed
- **#BL-027** — Local reviewer inbox (ALAYA_REVIEWER_TOKEN + ALAYA_REVIEWER_IDENTITY)
- **#BL-028** — Path plasticity owned by Librarian (TIER_2 Garden path)
- **#BL-029** — Direction-bias redirection consumer (PathRelation → recall)
- **#BL-030** — Explicit PathLifecycle status
- **#BL-031** — Sync-first storage repos
- **#BL-032** — Scoped EventLog query for path plasticity
- **#BL-033** — Batched recall plasticity lookup
- **#BL-034** — Review-surface parity (MCP/Inspector HTTP/CLI)
- **#BL-035** — Durable path-plasticity watermark (SQL, survives restart)
- **#BL-036** — Pending path-plasticity enqueue dedupe

Full close evidence in `docs/archive/v0.1-port-record/phase-5-followup-briefs/`.

---

## Resolved by p5-system-review-r1/r2 (2026-05-03)

- **#BL-023** — Promoted to invariant §21a (Public-facing copy audience rules)
- **#BL-024** — HTTP `POST /proposals/:id/review` route removed
- **#BL-014** — Atomic fix-commit hygiene proven (30+ atomic commits)
- **#BL-016** — Folded into #BL-017
- **#BL-017** — Post-port hygiene wave executed (domain renaming, file splits, knip)

---

## Resolved — Short closure summaries

- **#BL-022** — EventPublisher port atomicity + EventLog revision transaction (v0.1-closeout-a2)
- **#BL-019** — Embedding-supplement paste secret_ref pipeline (Inspector → daemon proxy)
- **#BL-015** — Trust state SQL persistence (delivery/usage records)
- **#BL-020** — Trust installed/configured/unverifiable counter persistence (EventLog replay)
- **#BL-012** — Memory Inspector (P4-cli-inspect + P4-inspector-server + P4-inspector-frontend)
- **#BL-013** — Dedicated Green grace-transition event
- **#BL-018** — attached-agent MCP proof harness
- **#BL-010** — `alaya detach` reverse-attach command
- **#BL-011** — Cross-workspace global recall cache invalidation

---

## Resolved — #BL-009 (OS keychain for secrets)

**Status**: Resolved in v0.3.0. `keychain:<service>:<account>` secret refs resolve through platform-native API (macOS Keychain / Linux libsecret / Windows Credential Manager). Code-reviewed on all platforms; runtime keychain write/read not exercised due to WSL2 dev environment. `env:` / `file:` refs are the runtime-verified path.

