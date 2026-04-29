# Gate-3 Closeout Report

## Scope

Gate-3 closes Phase 3 Wave 3: foundation helpers, MCP discovery services,
run lifecycle / serial delegation services, misc support services,
ConversationService memory orchestration, ContextLensAssembler, and the core
barrel.

Phase 3 has 6 task cards and 6 task completion reports.

## Readiness

Gate-3 status: passed.

Closed readiness label: `implementation-ready`.

This closeout does not claim daemon, MCP server transport, CLI, attached-agent,
or live event readiness. Those live-consumption paths remain Phase 4 work.

Product-scope prune decisions are final for Phase 3-owned surfaces: upstream
slash command discovery, chat-specific worker dispatch, concrete
runtime-adapter sessions, tool-substrate chat execution, and system-prompt
assembly are not deferred backlog items for Alaya v0.1.

## Fresh Verification

All checks ran in `/home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p3-controller`.

- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/protocol` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol packages/protocol/src/__tests__/command-control.test.ts` - passed; 1 file / 1 test.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/conversation-service.test.ts packages/core/src/__tests__/context-lens-assembler.test.ts packages/core/src/__tests__/mcp-tool-discovery-service.test.ts packages/core/src/__tests__/extension-registry-service.test.ts` - passed; 4 files / 49 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core` - passed; 65 files / 587 tests.
- `rtk pnpm test` - passed; 189 files / 1592 tests.

## Drift Sweeps

- `rtk rg -n "@do-what/|SseBroadcaster|EventSource|text/event-stream" --glob '!vendor/**' --glob '!docs/**' --glob '!node_modules/**' --glob '!packages/*/node_modules/**' --glob '!*.log' .` - no code/config matches.
- `rtk rg -n "SlashCommand|slash command|slash-command|slash-local|slash-commands|runtime-adapters|system-prompt|tool-substrate|conversation-streaming|SendMessageInput|ConversationResponse|SseBroadcaster|EventSource|text/event-stream|@do-what/" packages/core/src packages/engine-gateway/src packages/protocol/src packages/storage/src packages/soul/src --glob '!**/__tests__/**' --glob '!**/test-doubles/**'` - no production package matches.
- `rtk rg -n "#BL-004|#BL-04|#BL-012|ConversationService chat-specific orchestration|Frontend GUI|Conversation TUI|apps/tui|packages/ui-sdk|surface-runtime|Daemon SSE|Inspector UI|chat-specific orchestration.*defer|Chat worker dispatch runtime behavior.*defer" docs --glob '!docs/v0.1/phase-3-briefs/reports/gate-3-closeout.md'` - no matches.
- Phase 3 docs still mention upstream `@do-what/*` and SSE names only in port-rule, adapter-point, and report evidence text.

## Review And Fix Loop

Per-card review/fix loops closed before this report:

- `P3-misc-foundation` review: clear after controller repair moved accidental
  main-checkout writes back into the Phase 3 worktree.
- `P3-mcp-discovery` review: Important notifier call-count proof gap fixed and
  re-reviewed clear.
- `P3-run-lifecycle` review: clear.
- `P3-misc-services` review: Important dynamics notifier proof gap fixed and
  re-reviewed clear.
- `P3-conversation` review: Blocking governance lease release gap and
  Important chat DTO export gap fixed and re-reviewed clear.
- `P3-core-barrel` review: two read-only reviewers returned clear; the barrel
  exports implemented Phase 2/3 core services and excludes runtime-adapter,
  system-prompt, tool-substrate, slash, chat DTO, test-double, and SSE-named
  surfaces.
- Final Gate-3 review found three docs-truth/product-boundary issues and one
  under-reported code-map item. The fix loop removed public `SlashCommand*`
  protocol schemas and slash tests, removed product-pruned GUI/TUI/SSE items
  from backlog deferrals, repaired `P3-conversation` and
  `P3-misc-foundation` adapter matrices, added `graph-explore-service.ts` to
  the code map, and pruned stale Phase 4 slash / chat-worker dispatch route
  planning references.

Prevention hooks added:

- `docs/handbook/port-protocol.md` now records the Product-Scope Prune Rule:
  product-unrelated upstream features are pruned by default, not deferred; if
  relevance is unclear, the agent must ask the user before adding task-card,
  report, or backlog scope.
- `P3-misc-services`, `P3-run-lifecycle`, and `P3-conversation` docs now record
  product-scope pruning instead of backlog/deferred scope for slash or
  chat-runtime surfaces.
- `P3-core-barrel` report records forbidden export sweeps over the public core
  barrel.

No Phase 3 Blocking or Important review finding remains open.

## Phase 4 Boundary

Phase 4 owns daemon wiring, MCP server transport, MCP memory tool handlers,
CLI bridge, profile mutation, secrets, operations, and attached-agent proof.
Gate-3 only proves the core implementation surface those Phase 4 cards will
consume.
