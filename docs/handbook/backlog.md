# Backlog

Cross-phase unresolved issues. Scheduled work keeps detailed acceptance
criteria in the owning phase README or task card. Resolved issues are
archived to `docs/archive/backlog-resolved-historical.md`.

## Issue Numbering

Issues are numbered `#BL-NNN` in plain decimal sequence.
**Next available number**: `#BL-058`.

---

## Open Issues

### #BL-051 — Abstention calibration re-test on 500q data

**Status**: Open (deferred to R5 data; opened v0.3.11). **Due**: after the R5 big-machine 500q gate.

**Context**: `abstain_false_confident=9` misses are a calibration question, not a threshold-bump. Re-test needs real 500q data, gated on the big-machine R5 run.

**Close condition**: re-evaluate against R5 500q cached archive; either land a calibrated evidence-strength signal or record "calibration inert on real corpus".

### #BL-052 — Scale LongMemEval CI sample-floor (was #BL-040)

**Status**: Open (re-opened as scale-up; v0.3.11). **Due**: after a larger CI host is available.

**Context**: CI sample-floor still runs small because 500q full bench OOMs on the 7.6 GB WSL2 box. Needs a larger CI host (same constraint that defers the R5 gate).

**Close condition**: a larger CI host runs a category-balanced sample-floor at or above the confidence-interval threshold without OOM, wired into the CI gate.

### #BL-053 — Edge `llm_supports` LOCAL pair-classifier (host-worker / ONNX)

**Status**: Open (deferred; v0.3.11). **Due**: revisit alongside local ONNX cache work.

**Context**: `EdgeAutoProducerService` accepts an optional in-process pair-classifier port, but a LOCAL (host-worker / ONNX) classifier producing `llm_supports` is not yet built. Local rule heuristic tags `local_*` only.

**Close condition**: a local pair-classifier produces confidence-floor-clearing `llm_supports` verdicts offline, with a no-network regression.

### #BL-054 — Lease-pierce governance-cache hot-path hook

**Status**: Open (deferred; v0.3.11). **Due**: revisit if governance cache moves onto the production recall hot path.

**Context**: Lease-pierce invalidation hook for the governance cache was scoped during D-LEASE. The governance cache is NOT on the production recall hot path today, so the hook is moot. Kept open to preserve the dependency.

**Close condition**: close as not-needed if the cache stays off the hot path through v0.3.12; otherwise land the hook with a test.

### #BL-047 — `multi_hop_path` as a dedicated recall fusion stream

**Status**: Open (deferred by explicit operator decision, v0.3.11).

**Context**: Multi-hop traversal already exists (2-hop BFS folds into `graph_expansion`). `multi_hop_path` would give multi-hop candidates their own dedicated fusion lane. Lowest-ROI item in the D-series.

**Close condition**: revisit if a 500q root-cause diagnostic shows multi-hop gold drowned inside `graph_expansion` and needing a separate lane.

### #BL-057 — Warm-workspace witness for base-weight recall priors

**Status**: Open (v0.3.11; residual from B2 fusion-prior correction).

**Context**: B2 subordinated non-evidence fusion streams to base weight. A warm-seeding A/B harness does not exist (same constraint as R5 gate / #BL-052).

**Close condition**: a warm-seeding A/B confirms no warm recall regression from base-weight priors; or "warm-neutral on real corpus" verdict against R5 archive.

---

## Out of Alaya Scope (Permanently Rejected)

These would never enter Alaya's roadmap. Each entry documents *why*:

- **#BL-001 — Frontend GUI**: not in Alaya scope. Memory Inspector is the only Alaya-side UI; agent-flow UIs belong to the consuming agent. See invariant §21.
- **#BL-002 — Conversation TUI**: consuming agent's responsibility.
- **#BL-003 — `apps/tui/` upstream port**: no Alaya counterpart.
- **#BL-004 — ConversationService chat-specific orchestration**: dropped during v0.1 port.
- **#BL-005 — `packages/ui-sdk/`**: no shared HTTP client surface justifies a dedicated SDK.
- **#BL-006 — `packages/surface-runtime/`**: Alaya has no agent UI requiring a shared surface reducer.
- **#BL-007 — Daemon SSE pipeline**: stripped per invariant §11.

---

## Issue Format

```markdown
### #BL-NNN — <one-line title>

**Status**: <Open | Deferred | Resolved>
**Close condition**: <what acceptance test must pass>

<one-paragraph context>
```

Per Anti-Tail Rule R2, every deferral from a task card MUST cite a numbered backlog issue here.
