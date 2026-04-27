# ALA-R5 - Recall And Context Assembly

## Goal

实现 deterministic lexical/FTS recall、path-aware recall、embedding supplement、agent-assisted candidate route、context pack、exclusion explanation 和 degradation metadata。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/storage/src/migrations/049-memory-fts-trigram-upgrade.sql:7`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/repos/memory-entry-repo.ts:240`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/repos/memory-entry-repo.ts:439`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/task-c25-fts5-trigram-upgrade.md:13`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/task-c26-embedding-supplement-recall.md:32`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/recall-service.ts:501`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/embedding-recall-service.ts:280`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/context-lens.ts:8`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/context-lens-assembler.ts:179`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/conversation-service.ts:1737`

## Alaya Adaptation

- FTS/lexical recall is the baseline and works without embeddings。
- embedding is additive, explicit opt-in, no hard remote dependency。
- context lens and working projection are current-turn derived context, not durable truth。
- recalled context is data context, not instructions。

## Non-goals

- 不实现 provider management UI。
- 不实现 graph inspector。
- 不把 embedding 结果写成 durable truth。

## Scope

- FTS/lexical recall。
- path-aware recall。
- embedding supplement route。
- context pack。
- exclusion/degradation explanation。

## Inputs

- query/task。
- user/project scope。
- recall policy。
- provider status。
- PathRelation state。

## Outputs

- included candidates with reasons。
- excluded candidates with reasons。
- context pack id。
- degradation metadata。
- route contribution metadata。

## Acceptance

- keyword/FTS recall works when embeddings are disabled/unavailable。
- embedding only runs when explicitly enabled and configured。
- embedding appends non-duplicate candidates after baseline recall and within budget。
- provider/vector failures degrade to keyword-only and are auditable。
- context pack identifies source plane and does not claim durable truth。
- exclusion records include id/route/reason/scope/governance state。

## Verification

- FTS exact fallback/trigram/CJK tests。
- recall merge deterministic ordering tests。
- embedding disabled/configured/enabled/degraded tests。
- context pack snapshot tests。
- exclusion explanation tests。

## Review Lens

- recall correctness。
- degradation safety。
- context-vs-instruction boundary。

## Stop Conditions

- If recall depends on remote provider for baseline success, stop and redesign.
