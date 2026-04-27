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

## Source Classification

- `source-backed`: FTS5/trigram lexical recall、`searchByKeyword()` 的 BM25
  排序、embedding additive supplement 与失败降级、`ContextLens` /
  `WorkingProjection` 属于 runtime control plane。
- `alaya-adapted`: 将 do-what-new 的 FTS、path、manifestation 与
  context lens 机制改写为 Alaya 独立的 structured recall、lexical/FTS
  baseline、path-aware recall、context pack 与 exclusions metadata。
- `alaya-default`: v0.1 默认 lexical/FTS 可独立工作；embedding 只作为显式
  opt-in supplement；recalled context 是 data context，不是 instructions；
  context pack 必须解释 included、excluded 与 degraded 的原因。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R1 runtime/API and audit baseline.
- ALA-R2 durable ontology records and ALA-R3 path/manifestation contracts.
- ALA-R4 governance visibility/exclusion rules.

## Parallel With

- ALA-R6 provider capability work after embedding is constrained to additive
  supplement behavior.
- ALA-R7 trust reporting work after context pack and delivery metadata are
  named.

## Write Ownership

- Planned structured recall, lexical/FTS baseline, path-aware recall, embedding
  supplement route, context pack, exclusion/degradation metadata, and focused
  tests.
- Do not own provider management UI, graph inspector delivery, or any embedding
  path that writes durable truth.

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

## Implementation Subcards

### ALA-R5.1 - Structured and lexical/FTS baseline recall

#### Scope

- 建立 Alaya structured recall + lexical/FTS baseline：scope、object kind、
  governance visibility、retention/tombstone 状态先过滤，再进入 lexical/FTS
  ranking。
- 保留 deterministic ordering：lexical score、structured filter outcome、
  tie-break id 都必须可解释。
- baseline 必须在 embedding disabled、未配置、失败或超预算时仍可返回结果。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/storage/src/migrations/049-memory-fts-trigram-upgrade.sql:7`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/repos/memory-entry-repo.ts:240`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/repos/memory-entry-repo.ts:439`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/task-c25-fts5-trigram-upgrade.md:13`
- `../extraction-ledger.md`

#### Acceptance

- lexical/FTS recall 是 v0.1 的 required baseline，不依赖 embedding 或 remote
  provider。
- short token、trigram substring、CJK span 都有确定的 baseline 召回语义。
- tombstoned、scope-mismatched、governance-hidden entries 不进入 included
  candidates。
- baseline result 包含 route contribution metadata，能说明 structured 与
  lexical 各自贡献。

#### Verification

- Planned unit tests: exact fallback、trigram substring、CJK span、empty query、
  tombstone/scope filter。
- Planned deterministic tests: same input 得到稳定排序和 tie-break。
- Planned snapshot tests: route contribution metadata 不把 projection 写成
  durable truth。

#### Review Lens

- lexical baseline 是否可独立运行。
- structured filter 是否先于 ranking 生效。
- ranking/tie-break 是否 deterministic 且可解释。

#### Stop Conditions

- If lexical/FTS baseline cannot return without embedding, stop and redesign.
- If structured recall bypasses governance or retention filters, stop and fix.

### ALA-R5.2 - Path-aware recall integration

#### Scope

- 将 `PathRelation`、manifestation state、path support 与 current-turn query
  合并到 recall candidate scoring。
- path-aware recall 只能影响 runtime candidate/projection，不得创建新的
  durable memory truth。
- path contribution 必须能解释为什么某条 memory 在当前 task/scope 下被激活。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/core/src/recall-service.ts:501`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/context-lens.ts:8`
- `../extraction-ledger.md`
- `../../handbook/invariants.md`

#### Acceptance

- path-aware signal 与 lexical baseline 合并时不覆盖 baseline 可用性。
- path contribution metadata 包含 path id/type/support reason 或明确缺失原因。
- Path 是 learned conditional relation；recall/prediction/reminder 只是当前轮显影。
- path-aware recall 不改变 `MemoryEntry` durable state，除非后续治理路径显式写入。

#### Verification

- Planned merge tests: lexical-only、path-only、lexical+path 的排序和解释。
- Planned boundary tests: path signal 只出现在 runtime output，不写 durable ontology。
- Planned governance tests: path signal 不解封被 governance 排除的 memory。

#### Review Lens

- PathRelation 与 durable ontology 边界是否清楚。
- path signal 是否 additive，而不是隐式 promotion。
- current-turn manifestation 是否可审计。

#### Stop Conditions

- If path-aware recall silently promotes runtime candidates to durable truth, stop and fix.
- If path signal can override governance exclusion, stop and redesign.

### ALA-R5.3 - Embedding supplement and degradation

#### Scope

- 在 structured + lexical/FTS baseline 之后添加 embedding supplement。
- embedding 需要 explicit opt-in、provider configured/enabled/healthy、budget
  允许，且只能追加 non-duplicate candidates。
- embedding query、vector load、provider failure 或 timeout 必须降级到 baseline
  recall，并记录 degradation metadata。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/task-c26-embedding-supplement-recall.md:32`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/recall-service.ts:501`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/embedding-recall-service.ts:280`
- `../extraction-ledger.md`

#### Acceptance

- embedding disabled 或未配置时行为等同 lexical/FTS baseline。
- embedding supplement 在 governance-filtered baseline 之后执行，不作为 primary
  recall route。
- duplicate memory ids 不会重复进入 context pack。
- degraded recall 返回 baseline candidates，并说明 degradation reason、provider
  state、fallback candidate count。

#### Verification

- Planned tests: disabled、enabled、provider missing、query pending、provider error、
  duplicate merge、budget capped。
- Planned audit tests: degradation metadata 和 fallback count 可被 session audit 引用。
- Planned regression tests: embedding failure 不改变 lexical-only ordering。

#### Review Lens

- opt-in 与 provider health gate 是否明确。
- embedding 是否只是 additive supplement。
- degradation 是否可审计且不影响 durable truth。

#### Stop Conditions

- If embedding runs before structured/governance/FTS baseline, stop and redesign.
- If embedding failure aborts baseline recall, stop and fix.

### ALA-R5.4 - Context pack/exclusions/explanation metadata

#### Scope

- 生成 Alaya `ContextPack`：included candidates、excluded candidates、source plane、
  route contribution、degradation state、token/budget metadata。
- excluded records 必须解释 route、reason、scope/governance state 与是否可重试。
- context pack 是 session/runtime artifact，不是 durable Memory Ontology。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/context-lens.ts:8`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/context-lens-assembler.ts:179`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/conversation-service.ts:1737`
- `../../handbook/invariants.md`

#### Acceptance

- context pack 明确标记 source plane：ontology、structure registry、runtime
  projection、degradation。
- included item 说明 inclusion reason；excluded item 说明 exclusion reason。
- delivery text 明确 recalled context 是 data context，不是 instructions。
- context pack id 可被 ALA-R7 session audit 引用，但自身不代表 used proof。

#### Verification

- Planned snapshot tests: context pack included/excluded/degraded metadata。
- Planned budget tests: over-budget entries 有 exclusion 或 degradation explanation。
- Planned boundary tests: context pack 不写 durable truth，不声明 memory 被使用。

#### Review Lens

- context-vs-instruction 边界。
- exclusion explanation 是否足以支持 operator review。
- ALA-R7 usage proof 是否只引用 delivery，不误判 used。

#### Stop Conditions

- If context pack is treated as durable truth, stop and fix.
- If delivery of context is counted as usage proof, stop and align with ALA-R7.
