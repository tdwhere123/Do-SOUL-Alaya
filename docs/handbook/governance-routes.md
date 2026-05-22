# Governance Routes

Alaya keeps governance decisions explicit and auditable. Runtime code
currently exposes five compatible surfaces, but contributors must reason
about them as four governance route families. New governance work must
join one of these families instead of adding another route.

## Route Families

1. **Scoring pressure**

   Use this when the system can classify risk or contradiction before a
   durable state decision exists, but should not block the current agent
   turn. `ConflictDetectionService.evaluate` and supersede penalties live
   here. The consumer is the ranker or producer-side scorer; the output is
   score pressure or candidate metadata, not a durable correction.

2. **Recall-time warning**

   Use this when the agent must see a stop-time warning while answering
   with recalled context. `staged_warnings[]` on recall payloads live
   here. The consumer is the attached agent; older agents may ignore the
   optional field. Warnings do not mutate durable memory by themselves.

3. **Out-of-band review queue**

   Use this when a human or reviewer agent should inspect an issue after
   the current turn. `HealthIssueGroup` and `Proposal` are the two runtime
   payload shapes in this family:

   - `HealthIssueGroup` groups observed health issues for Inspector
     triage, such as orphan radar, evidence failure, or green revocation.
   - `Proposal` carries an explicit proposed durable change, reviewed by
     `soul.review_memory_proposal` or Inspector review controls.

   They remain separate schemas because their payloads differ, but they
   are not separate governance concepts. Both are review-queue work.

4. **Inline typed resolution**

   Use this when the attached agent is making an immediate, typed
   governance decision in the active turn. `soul.resolve` lives here.
   It supports confirm, reject, correct, stale, defer, and not_relevant.
   Durable promotion or lifecycle transition must be recorded in EventLog
   and guarded by storage CAS.

## Decision Rule

- If the output is only a ranking or producer pressure signal, use
  scoring pressure.
- If the attached agent must be warned before answering, use recall-time
  warning.
- If the issue can wait for reviewer triage, use the out-of-band review
  queue. Choose `HealthIssueGroup` for grouped health observations and
  `Proposal` for a concrete proposed durable mutation.
- If the agent is deciding now and the decision has a typed resolution,
  use inline typed resolution.

Do not add a new MCP verb, Inspector-only mutation, EventLog event
family, or storage table for governance until this decision rule fails.
When it does fail, update this file and `docs/handbook/invariants.md`
before changing runtime code.

## Current Runtime Surface Mapping

- `ConflictDetectionService.evaluate` + supersede penalty: scoring
  pressure.
- `staged_warnings[]` on recall payloads: recall-time warning.
- `HealthIssueGroup` + Inspector Health Inbox: out-of-band review queue.
- `Proposal` / `soul.propose_memory_update`: out-of-band review queue.
- `soul.resolve`: inline typed resolution.
