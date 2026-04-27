# Completeness Checklist

SOUL Memory should not be called complete because it has a few recall calls.
Complete means a user can install it, connect an agent, inspect stored memory,
govern mistakes, move data, and see task-level improvement.

## Product Completeness

- [ ] Clear standalone positioning and README.
- [ ] One-command install path.
- [ ] Local setup and doctor flow.
- [ ] Local serve flow for API and MCP.
- [ ] Storage path and profile behavior documented.
- [ ] No dependency on a checked-out `do-what` repo.

## Memory Completeness

- [ ] Durable memory object model.
- [ ] Global Personal Memory plane.
- [ ] Project/Local Memory plane.
- [ ] Explicit source-plane labels on recall and context-pack entries.
- [ ] Source and evidence required for durable memory.
- [ ] Scope model for workspace/project/user/path.
- [ ] Recall candidates include reasons.
- [ ] Recall exclusions include reasons.
- [ ] Context packs can be assembled for agent turns.
- [ ] Memory lifecycle states are explicit.
- [ ] Conflicts and sensitive content can be represented.

## Governance Completeness

- [ ] Accept/reject/retire actions.
- [ ] Strengthen/weaken or equivalent path plasticity controls.
- [ ] Scope move/correction path.
- [ ] Audit events for all governance mutations.
- [ ] Import/export/backup events are auditable.

## Integration Completeness

- [ ] MCP server exposes the first stable tool set.
- [ ] MCP config helper works for at least one real agent.
- [ ] Attach Mode assets can raise usage rate without claiming enforcement.
- [ ] Gateway Mode can force pre-recall and post-run ingest.
- [ ] MemorySessionContract records delivered, used, skipped, and unverifiable
  memory behavior.
- [ ] Inspector can show installed-but-unused agent runs.
- [ ] CLI can exercise recall and ingest without custom scripts.
- [ ] HTTP API can serve inspector and future consumers.
- [ ] Skills/instructions exist only after MCP semantics are stable.

## Inspector Completeness

- [ ] Point-based memory graph is the primary view.
- [ ] Context-pack highlight works on the graph.
- [ ] Local/project versus global/personal filters work.
- [ ] Recalled, excluded, stale, and rejected filters work.
- [ ] Memory list.
- [ ] Memory detail with source/evidence.
- [ ] Recall explorer with explanations.
- [ ] Scope browser.
- [ ] Audit timeline.
- [ ] Export selected or scoped data.
- [ ] Optional governance actions are audit-backed before enabling.

## Evaluation Completeness

- [ ] At least one coding-task benchmark.
- [ ] At least one review/fix-loop benchmark.
- [ ] At least one long-context continuation benchmark.
- [ ] Installed-but-unused failure case.
- [ ] MCP attach-used case.
- [ ] Gateway-forced case.
- [ ] Results compare without-memory vs with-memory agent behavior.
- [ ] Evaluation records failures and false recalls, not only wins.

## Market-Ready Bar

The product is market-test ready when a new user can:

1. Install it.
2. Start it.
3. Connect one agent through MCP.
4. Run one task in Gateway Mode or otherwise prove memory was used.
5. Inspect what was stored, why it was recalled, and whether the agent used it.
6. Reject one bad memory.
7. Export or back up the memory store.
