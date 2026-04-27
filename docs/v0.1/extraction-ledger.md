# v0.1 Source Adaptation Policy

Status: execution policy for task cards. Stable source hierarchy and extraction
boundaries live in [Extraction Source Map](../handbook/extraction-source-map.md).

Do-SOUL Alaya v0.1 does not redesign SOUL from scratch. It extracts the
source-backed SOUL model from `/home/tdwhere/vibe/do-what-new`, adapts it into
an independent local-first CLI agent memory product, and records every
adaptation explicitly in task cards.

## Classification

| Classification | Meaning | AI action |
|---|---|---|
| `source-backed` | The source repository has explicit truth for the behavior or concept. | Translate into Alaya terms and make it acceptance criteria. |
| `alaya-adapted` | The source repository has a kernel, but Alaya needs a product or boundary adjustment. | Record inherited point, adaptation point, and misuse risk. |
| `alaya-default` | The decision is an adopted Alaya product default. | Implement the default unless the user explicitly changes it. |
| `deferred` | The item is outside the current v0.1 acceptance envelope. | Keep out of current cards or mark as a later-stage dependency. |

## Required Source Order

Task cards should read sources in this order before asking for user decisions:

1. `/home/tdwhere/vibe/do-what-new/docs/handbook/architecture.md`
2. `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md`
3. `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md`
4. `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/03-architecture.md`
5. `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/04-algorithms.md`
6. `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/08-glossary.md`
7. `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/`
8. `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/`
9. `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/` for operator
   surface, embedding posture, and manual-operation lessons only.

## Adopted Product Defaults

These defaults are already in scope for v0.1 task cards:

- display name: **Do-SOUL Alaya**;
- namespace target: `@do-soul/alaya`;
- product role: local-first long-term memory core for CLI agents;
- runtime shape: local daemon core;
- access order: MCP-first, CLI protocol fallback;
- first attachment targets: Codex and Claude Code;
- configuration planes: User scope and Project scope override;
- Attach/Profile writes: preview first, explicit consent before writing;
- Gateway mode: optional envelope for stronger proof and benchmark runs;
- graph inspector: Phase 2 point-network surface backed by runtime/API data;
- embedding: recall/index supplement, not durable-truth authority;
- LLM, connected agents, and subagents: proposal sources only;
- Alaya runtime: final durable-truth gate.

## Card Rules

Every implementation task card must include:

- source references;
- source classification;
- inherited source truth;
- Alaya adaptation, if any;
- misuse risks;
- acceptance criteria tied to the classification;
- verification and review lens.

When source material conflicts with handbook invariants, stop and report the
conflict. Do not merge the contradiction into an implementation card.
