# Competitive Positioning

Status: draft; external landscape checked on 2026-04-27. Claims here should be
kept evidence-based and rechecked before public release.

## Category

SOUL Memory should be positioned as:

```text
local-first governed memory-of-record for coding and research agents
```

It is not primarily:

- a vector database;
- a graph database;
- a chat personalization feature;
- a generic RAG layer;
- an agent framework;
- a workbench UI;
- a cloud/team memory platform in its first release.

## External Landscape

This is the current reference set to compare against:

- Mem0: managed memory layer for AI agents, with MCP integration, hosted
  infrastructure, graph memory, rerankers, workspace governance, and dashboard.
  Sources: https://docs.mem0.ai/platform/overview and
  https://docs.mem0.ai/platform/features/mcp-integration
- Letta: stateful agents with core memory blocks, archival memory, and
  agent-managed memory tools. Source:
  https://docs.letta.com/guides/agents/memory
- Zep / Graphiti: temporal knowledge graph for agent memory, dynamic facts,
  hybrid search, temporal handling, and relationship history. Source:
  https://help.getzep.com/graphiti/graphiti/overview
- LangMem / LangGraph memory: primitives for semantic, episodic, and procedural
  memory, hot-path/background writes, and storage integration. Source:
  https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- Cognee: AI memory/knowledge graph layer with add/cognify/search/memify and
  vector + graph retrieval. Source:
  https://docs.cognee.ai/getting-started/introduction
- ChatGPT Memory: end-user saved memories and chat-history reference, with user
  controls and memory visibility. Source:
  https://help.openai.com/en/articles/8590148-memory-faq

## Defensible Difference

SOUL Memory should not try to beat every product on hosted scale, generic vector
search, or generic temporal knowledge graph sophistication first. Its strongest
initial wedge is:

1. Local-first agent memory for developers and operators.
2. Global personal memory plus project/local memory.
3. Evidence-backed durable memory, not opaque extracted notes.
4. Memory governance as a first-class product surface.
5. Recall explanations and inspector trust loop.
6. Point-based graph inspector for understanding memory relationships.
7. Agent usage audit that distinguishes installed, delivered, and used memory.
8. Agent-neutral MCP access plus Gateway Mode for guaranteed usage.
9. `do-what` as a demanding real-world proof harness.

## Product Claim

Use this claim internally until benchmark data exists:

> SOUL Memory helps agents carry project decisions, evidence, constraints, and
> learned working patterns across tasks while keeping every durable memory
> inspectable, governable, and auditable by the operator.

Do not claim "best memory layer" or "better than X" until benchmarks prove it.

## Competitive Axes

| Axis | SOUL Memory target | Why it matters |
| --- | --- | --- |
| Local-first | Default local daemon + SQLite | Useful for coding agents and private repos |
| Global personal + project memory | Personal cross-project memory plus repo-local memory | Captures both operator continuity and project truth |
| Evidence | Source/evidence required for durable memory | Users can trust and debug memory |
| Governance | Accept/reject/retire/weaken/strengthen | Bad memory can be corrected, not just deleted |
| Recall explanation | Reasons, sources, excluded items | Operator can see why context appeared |
| Graph inspector | Point-based memory relationship view plus detail panel | Users can understand how memory connects and why it was recalled |
| Usage audit | Session contract records delivered/used/skipped memory | Installed memory that agents ignore is visible |
| Path-aware behavior | Relations influence recall and stance | Goes beyond simple semantic search |
| MCP + Gateway | Universal access plus enforced run mode | Works across clients while supporting guaranteed memory use |
| do-what proof | Real orchestration/workbench consumer | Validates under complex workflows |

## What To Avoid

- Do not compete head-on with Graphiti/Zep as a general temporal knowledge
  graph. SOUL's point-based memory graph is a core understanding interface, not
  a claim to be the deepest graph database.
- Do not lead with "managed memory in minutes"; Mem0 already owns that category
  more directly.
- Do not lead with "stateful agent framework"; Letta owns much of that framing.
- Do not lead with "semantic/episodic/procedural memory primitives"; LangMem
  and LangGraph already frame this well.
- Do not lead with "documents to knowledge graph"; Cognee is closer to that
  framing.
- Do not describe Global Personal Memory as cloud, team, or shared memory by
  default. It is local-first personal memory.

Lead with trust, governance, evidence, local ownership, and coding-agent
continuity.

## Built-In Agent Memory Difference

Codex, Claude, ChatGPT, and other agent clients may have built-in memory or
profile features. SOUL Memory should distinguish itself this way:

- built-in memory is usually agent-private preference or chat context;
- SOUL Memory is an operator-owned, local-first memory-of-record;
- built-in memory is rarely project-auditable;
- SOUL Memory exposes source, evidence, governance, recall explanation, graph
  inspection, import/export, and usage audit;
- SOUL Memory can serve multiple agents and repos through the same public API.

## External Fact Refresh

The external links above are planning references. Before public release, refresh
the landscape and rewrite any competitor claims against current public docs.
