# API 与契约（v0.1 计划）

公共契约是语义根。MCP、CLI protocol、Gateway wrapper、Inspector、benchmark
都必须反映同一套 runtime 行为。

## 契约层次

- Product contract：记忆语义、证据、治理、trust rules。
- Runtime API contract：durable operations 与 validation。
- Adapter contract：MCP-first，CLI protocol fallback。
- Session contract：run 级激活、使用证明与 ingest 结果。
- Provider contract：embedding、agent-assisted recall、LLM/agent proposal。

## 第一稳定 Runtime 操作

Health / profile：

- `health`
- `doctor`
- `getVersion`
- `getStorageStatus`
- `getProfileStatus`
- `listProviders`

Recall / context：

- `recall`
- `assembleContext`
- `explainRecall`
- `listRecallCandidates`
- `listRecallExclusions`

Session / usage：

- `startMemorySession`
- `assembleContextForSession`
- `recordMemoryUsage`
- `recordMemoryIngest`
- `finishMemorySession`
- `getMemorySession`
- `listSessionViolations`

Ingest / governance：

- `proposeMemory`
- `proposePathRelation`
- `proposeGovernance`
- `ingestEvidence`
- `acceptCandidate`
- `rejectCandidate`
- `retireMemory`
- `markSensitive`
- `resolveConflict`

Portability：

- `exportBundle`
- `importBundle`
- `backup`
- `restore`

## MCP-first 与 CLI fallback

主路径：

- MCP tools/resources/prompts 映射到 runtime operations。
- MCP 不能被描述为“保证 agent 会调用”；它是能力面。

Fallback：

- CLI protocol 调用同一 runtime operations。
- fallback 需要产生同等 session/audit events。

Non-goal：

- 不允许 adapter-only mutation。

## Memory Session Contract

```text
memory_session_id
agent_kind
agent_client
agent_version
mode: connect | attach | gateway
user_scope_ref
project_scope_ref
started_at
finished_at
context_pack_id
context_pack_attached
usage_state: configured | delivered | used | skipped | unverifiable | mixed
post_run_ingest_state
provider_usage_summary
degradation_summary
violations
```

## Durable Truth Rules

- 只有 runtime 可以 commit durable memory。
- 每条 durable memory 必须有 source 和 evidence。
- Context pack、inspector overlay、benchmark view 都是 derived view。
- Governance 和 trust transitions 必须显式且可审计。

## Candidate Proposer Boundary

- Connected agent、子智能体、LLM provider 可以提出候选。
- Proposal 不等于 durable write。
- Runtime 校验 policy、evidence、conflict、scope、sensitivity、HITL。

## 高风险 HITL

默认需要显式确认：

- `ClaimForm`；
- reject / retire / override / strengthen；
- 敏感内容；
- 跨项目或全局强记忆；
- 强 `PathRelation` 改写；
- 低证据但会影响未来行为的 required guidance。
