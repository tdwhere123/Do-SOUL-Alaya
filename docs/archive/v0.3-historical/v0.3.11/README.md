# v0.3.11

Status: **implementation complete; big-machine 500q gate pending.**

**NOT "release closed."** All R0-R4 code work is landed and code-reviewed through
per-phase review-loops; the five Tier-1 benches have **not** been rerun on a larger
host yet (the local 7.6 GB WSL2 box OOMs at 500q). v0.3.11 is tagged only after the
R5 500q gate passes. **R@5 -> 90% is not claimed as achieved** — it is deferred to
that gate. The authoritative status, the proven-vs-unproven framing, and the
codex-Blocking / R-phase commit map live in
[`reports/v0.3.11-closeout-report.md`](reports/v0.3.11-closeout-report.md). The
task-worktree planning card is `.do-it/plans/v0.3.11-completion-masterplan.md`;
the tracked status of record is this README plus the closeout report.

## What landed (proven: code + review-loops + full build + targeted tests)

- **Garden compute zero-cloud default** — `host_worker` is the product default; the
  attached CLI agent is the compute. B-2 edge classification is a host-worker
  `EDGE_CLASSIFY` task with an eventual-consistency rule-heuristic fallback. Cloud
  edge-LLM is default-OFF; K4.5 zero-cloud holds by default (no-network regression).
- **Bench fidelity** — harnesses EARN accepted, recall-eligible positive co-recall
  PathRelations through the production co-usage gate.
- **Durable recall fan-in (R2)** — the temporary `session_cohort_fanin` heuristic is
  retired; durable accepted member -> representative hub edges are the carrier.
- **Forgetting-compression lifecycle** — both terminal arms are now armed behind
  the delete-authority gate. The `judged_useless` arm deletes only sourceless,
  never-reinforced rows; the compress arm deletes only a fully-consolidated member
  whose `evidence_refs` are a subset of a live capsule's evidence. The capsule
  preserves shared evidence plus a deterministic gist summary, not the member
  `content` byte-for-byte. Explicitly protected pinned / hazard / canon /
  consolidated memories are never compress-deleted (`#BL-049` closed).
- **Edge / path governance** — edge-proposal expiry (B5), `contradicts_refs`
  ref-hints (B7), path-relation failure -> Health Inbox (D-EDGEAUDIT).
- **Truth-boundary doc alignment** (B3) + debt cleanup.

## Protocol SemVer step (§25)

SemVer step: **Minor**. v0.3.11 moves the public protocol surface only through
additive fields / enum values / events: `local_contradicts`,
`GardenTaskResultEnvelopeSchema.edge_verdict`, and
`SoulGardenTaskExpiredPayloadSchema`. No covered MCP/EventLog/config field is
removed, renamed, newly required, or narrowed.

## I4 — bench synthesis is a diagnostic sidecar, NOT production coverage

The bench harness synthesizes edges/paths for fidelity measurement; that synthesis
is a **diagnostic sidecar**, not a substitute for production memory-compression
coverage. Separately, **production synthesis review accept -> create is now wired**
(R3a): the librarian/auditor synthesis review-proposal `accept` reaches a
`synthesis_create` branch that creates a capsule with a deterministic no-LLM summary
(atomic accept-with-events). The two are distinct — the bench sidecar does not stand
in for the production synthesis path, and the production path does not depend on the
bench.

## Release gates still open (R5, runs on the larger machine after merge)

| Gate | Required result | Status |
|---|---|---|
| LongMemEval-S 500 embedding off | R@5 >= 90% | PENDING |
| LongMemEval-S multiturn 500 embedding off | R@5 >= 90% | PENDING |
| LongMemEval-S crossquestion 500 embedding off | R@5 >= 90% | PENDING |
| LoCoMo 1982 embedding off | R@5 >= 55% | PENDING |
| LoCoMo 1982 local ONNX embedding on | R@5 >= 90% | PENDING |
| Token economy | every new full bench includes `recall_token_economy` per recall call | PENDING |

The local ONNX model cache is absent unless the parent supplies or fetches it before
the embedding-on LoCoMo run. Confirm variant/LoCoMo extraction-cache cost before any
paid run (operator-gated; the cache covers only the first ~100 questions).

## Evidence pointers

Every full bench write updates `latest-run*.json`; only a no-findings, hard-gate
passing run updates `latest-passing*.json` (`latest-baseline*.json` is a legacy
alias). Honest pre-R1/R2 baseline (500q OFF,
`docs/bench-history/public/2026-06-02T145620Z-d73dcc2-policy-chat`): R@1=52.0%
R@5=81.6% R@10=83.6% (clean, `llm_calls=0`). The 90%@50q earlier number was a
small-sample artifact.

## Closeout rule

Do not mark v0.3.11 as final / release-ready / full-evidence-passed until:

1. the five Tier-1 full benches above run on a larger host,
2. each archive includes the required token-economy block,
3. `latest-run*` / `latest-passing*` semantics are exercised by the new writes,
4. the closeout report maps the Blockings + R-phases to fresh verification, and
5. the parent review reports no unresolved Blocking or Important findings.
