# Integration Strategy

Status: draft from 2026-04-27 review.

## Access Order

1. Public API + localhost HTTP API.
2. MCP server.
3. CLI.
4. Gateway run entrypoint.
5. Inspector HTML.
6. Import/export/backup.
7. Typed SDK.
8. Skills/prompts / Attach Mode assets.
9. `do-what` adapter consumer.

## Rationale

The public API must be the semantic root. Every other surface should wrap it:

```text
MCP
CLI
SDK
Inspector
do-what adapter
  -> Public SOUL Memory API
    -> memory runtime
    -> storage + audit + governance
```

MCP is the first agent-facing integration because it is the most universal
agent access mode. MCP alone does not guarantee that an agent will use memory.
CLI is for setup and operations. Gateway Mode is the product entrypoint that can
guarantee pre-recall, context attachment, post-run ingest, and usage audit. The
inspector is a trust surface. Skills and prompts are Attach Mode guidance, not
enforced product behavior.

## First Stable API Slice

Freeze this before migration becomes implementation:

- `health`
- `ingestMemory`
- `ingestEvidence`
- `recall`
- `assembleContext`
- `explainRecall`
- `listMemories`
- `listEvidence`
- `listScopes`
- `listAuditEvents`
- `acceptMemory`
- `rejectMemory`
- `retireMemory`
- `startMemorySession`
- `assembleContextForSession`
- `recordMemoryUsage`
- `recordMemoryIngest`
- `finishMemorySession`
- `getMemorySession`
- `listSessionViolations`
- `exportBundle`
- `importBundle`

## MCP Surface

First MCP tools:

- `soul_memory.health`
- `soul_memory.recall`
- `soul_memory.assemble_context`
- `soul_memory.start_session`
- `soul_memory.finish_session`
- `soul_memory.record_usage`
- `soul_memory.record_ingest`
- `soul_memory.list_session_violations`
- `soul_memory.explain_recall`
- `soul_memory.ingest_memory`
- `soul_memory.ingest_evidence`
- `soul_memory.list_memories`
- `soul_memory.list_audit_events`
- `soul_memory.governance` with `action: accept | reject | retire | mark-sensitive`
- `soul_memory.export_bundle`

Read tools should be enabled first. Write and destructive governance tools
should require explicit setup and visible reason text.

## CLI Surface

Current local prototype happy path:

```bash
rtk pnpm exec tsc -p tsconfig.json
rtk node dist/cli/index.js setup --data-dir /tmp/soul-memory-product
rtk node dist/cli/index.js doctor --data-dir /tmp/soul-memory-product
rtk node dist/cli/index.js serve --data-dir /tmp/soul-memory-product
rtk node dist/cli/index.js mcp config --agent codex --data-dir /tmp/soul-memory-product
rtk node dist/cli/index.js inspector --data-dir /tmp/soul-memory-product
```

`mcp config` should print config by default and mutate agent config files only
with explicit user consent.

Gateway happy path:

```bash
rtk node dist/cli/index.js gateway --data-dir /tmp/soul-memory-product --query "task context" -- codex
```

The run command should assemble a context pack before launching the agent,
attach that pack to the session, record usage evidence where possible, request
post-run ingest, and write a `MemorySessionContract`.

## Attach Mode

Attach Mode can generate or update local instruction assets such as
`AGENTS.md`, `CLAUDE.md`, skills, or agent profile snippets. Its purpose is to
raise the probability that agents call SOUL Memory through MCP.

Attach Mode must be documented as best-effort. It cannot claim guaranteed
memory usage.

## Inspector Surface

Inspector is graph-first and read-only first:

- point-based memory graph;
- context-pack and session overlays;
- memory list;
- memory detail;
- evidence/source view;
- recall explorer;
- scope browser;
- audit timeline;
- export selected scope.

Governance actions can be added only after audit behavior is frozen.

## Security And Trust

- Local-only default.
- No cloud sync by default.
- Global Personal Memory is local personal memory, not shared cloud memory.
- Read operations available before write operations.
- Ingest/write operations require setup.
- Destructive governance actions require reason text.
- Import/export/backup are audited.
- MCP tools are labeled and treated as user-authorized actions.
- The inspector never infers memory truth locally.
