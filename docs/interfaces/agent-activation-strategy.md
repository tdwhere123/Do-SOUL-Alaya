# Agent Activation Strategy

SOUL Memory is not complete when it is merely installed. The product must show
whether an agent actually received, used, and updated memory during a run.

## Core Problem

MCP provides a universal integration surface, but it cannot force an agent to
call memory tools. A configured MCP server can sit unused for an entire session.
SOUL Memory therefore needs explicit activation modes and a session contract
that records whether memory was used.

## Access Modes

### Connect Mode

Connect Mode exposes SOUL Memory through MCP and public API tools.

Best for:

- broad compatibility;
- users who want low-friction setup;
- agents that decide when to call tools.

Limits:

- cannot guarantee pre-task recall;
- cannot guarantee post-run ingest;
- cannot prove compliance unless tool calls are recorded.

### Attach Mode

Attach Mode adds local instructions, skills, `AGENTS.md`, `CLAUDE.md`, or agent
profile snippets that tell the agent when and how to use SOUL Memory.

Best for:

- increasing memory usage rate;
- project-specific operating rules;
- agents that honor local instruction files.

Limits:

- still guidance, not enforcement;
- can drift if instructions are edited or ignored;
- cannot guarantee that recalled context influenced the answer.

### Gateway Mode

Gateway Mode runs the agent through a SOUL Memory-controlled entrypoint.

Current prototype command shape:

```bash
rtk node dist/cli/index.js gateway --data-dir /tmp/soul-memory-product --query "task context" -- codex
```

Best for:

- guaranteed pre-recall before the agent starts;
- guaranteed context-pack attachment;
- guaranteed post-run ingest prompt or capture;
- usage auditing and violation reporting.

Limits:

- deeper integration effort;
- agent-specific launch behavior;
- must avoid becoming a full task orchestrator.

## Product Decision

MCP is the first universal entry surface. Gateway Mode is the first guaranteed
usage surface. Attach Mode bridges the two by improving behavior in existing
agent sessions without pretending it can enforce memory usage.

## MemorySessionContract

Every agent run that claims SOUL Memory support should produce a session record.

Minimum fields:

```text
memory_session_id
agent_kind
agent_client
agent_version
session_ref
workspace_ref
project_ref
mode: connect | attach | gateway
started_at
finished_at
context_pack_id
context_pack_attached
used_memory
used_memory_events
post_run_ingest_requested
post_run_ingest_completed
missed_required_steps
violations
```

The contract is product-level, not a `do-what` run model. `do-what` can provide
host identity and evidence, but SOUL Memory owns the memory usage audit.

## Usage Events

Usage must be observable:

- context pack assembled;
- context pack attached to the agent;
- recall item rendered or delivered;
- agent cited, used, or ignored memory;
- memory write requested;
- post-run ingest completed;
- required step missed.

The product should avoid overclaiming "used" when it only knows "delivered".
When direct proof is unavailable, record the strongest truthful state.

## Inspector Requirement

The inspector must answer:

```text
Did this agent run actually use SOUL Memory?
```

The answer should be visible per session with mode, context pack, recalled
items, excluded items, usage events, ingest events, and contract violations.

## Failure Cases To Model

- MCP server installed but no memory tool called.
- Context pack assembled but not attached.
- Agent received memory but contradicted it without explanation.
- Post-run memory ingest was required but skipped.
- Project/Local Memory was available but only Global Personal Memory was used.
- Stale or rejected memory was recalled after governance changed.
