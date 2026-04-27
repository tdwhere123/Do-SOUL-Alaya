# MCP Surface

MCP should be the primary universal agent integration surface. It is the right
boundary for agents because it exposes capabilities without requiring each
agent to embed SOUL Memory internals.

MCP is not a usage guarantee. An agent can have SOUL Memory configured and
still fail to call any memory tool. Guaranteed usage belongs to Gateway Mode,
with Attach Mode as best-effort instruction support.

## MCP Role

MCP is not the memory engine. MCP is an adapter over the public API:

```text
Agent -> MCP tools/resources -> SOUL Memory API -> storage/audit/governance
```

MCP is the first universal agent-facing surface, but the public API remains the
semantic root. MCP must not contain special memory behavior unavailable to CLI,
SDK, inspector, or `do-what`.

## Tools

Current prototype tools:

- `soul_memory.health`
- `soul_memory.recall`
- `soul_memory.assemble_context`
- `soul_memory.start_session`
- `soul_memory.finish_session`
- `soul_memory.record_usage`
- `soul_memory.record_ingest`
- `soul_memory.ingest_memory`
- `soul_memory.ingest_evidence`
- `soul_memory.list_memories`
- `soul_memory.explain_recall`
- `soul_memory.list_session_violations`
- `soul_memory.governance` with `action: accept | reject | retire | mark-sensitive`
- `soul_memory.export_bundle`

## Resources

Recommended resources:

- `soul://memories/{memory_id}`
- `soul://scopes/{scope_id}`
- `soul://audit/events`
- `soul://context-packs/{context_pack_id}`
- `soul://recall/{recall_id}`
- `soul://sessions/{memory_session_id}`

## Prompts

Recommended prompts:

- `use_soul_memory_for_task`
- `summarize_recalled_context`
- `record_decision_with_evidence`
- `review_memory_changes`

Prompts are optional. They should teach usage patterns, not hide product
semantics.

## Agent Setup

Target setup should be simple:

```bash
rtk node dist/cli/index.js serve --data-dir /tmp/soul-memory-product
rtk node dist/cli/index.js mcp config --agent codex --data-dir /tmp/soul-memory-product
```

The generated config points at the local stdio MCP command and names the storage
profile being used. The ignored prototype prints config only; packaged agent
config mutation remains future work.

For guaranteed pre-recall and post-ingest behavior, use Gateway Mode instead:

```bash
rtk node dist/cli/index.js gateway --data-dir /tmp/soul-memory-product --query "task context" -- codex
```

## Access Policy

Default mode should be local and conservative:

- read operations allowed by default;
- write/ingest operations allowed only after explicit setup;
- destructive governance actions require reason text;
- export/import operations visible in audit;
- no cloud sync by default;
- global personal memory remains local personal memory by default, not shared
  memory.

MCP tools can represent powerful data access and code execution paths, so SOUL
Memory should follow the MCP specification's trust model: explicit user consent,
clear data access boundaries, tool safety labels, and no hidden mutation.

## Completion Bar

The MCP surface is complete when an external agent can:

1. Ask for relevant context for a task.
2. Explain why context was returned.
3. Record a new evidence-backed memory.
4. Read back what changed.
5. Let the operator reject or retire an incorrect memory.
6. Record whether the session delivered, used, skipped, or could not verify
   memory usage.
