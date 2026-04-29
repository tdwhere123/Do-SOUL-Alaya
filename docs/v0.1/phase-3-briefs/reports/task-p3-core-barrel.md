# Task P3-core-barrel Report

## Scope Compliance

- Card: `docs/v0.1/phase-3-briefs/task-p3-core-barrel.md`
- Port mode: `adapt-and-port`
- Source: `vendor/do-what-new-snapshot/packages/core/src/index.ts`
- Target: `packages/core/src/index.ts`

Only `packages/core/src/index.ts` and this report were edited.

## Adapter Deviations

- Replaced the upstream chat/runtime-oriented explicit barrel with an Alaya
  module re-export list for implemented Phase 2 and Phase 3 core services.
- Excluded concrete runtime adapters, `system-prompt/`, tool-substrate,
  slash command/discovery services, test doubles, tests, GUI/TUI/chat-only
  helpers, and `SseBroadcaster`-named exports.
- Exported RuntimeNotifier-named ports and the Phase 3 recall-to-model
  producer surface:
  - `ConversationService`
  - `ConversationContextLensAssemblerPort`
  - `ContextLensAssembler`
  - `AssembleResult`

## Verification

All checks ran in the Phase 3 controller worktree
`/home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p3-controller`.

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/core/src/index.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\n'));process.exit(1);}"` — passed
- `rtk git diff --check` — passed
- `rtk rg -n "slash|system-prompt|runtime-adapters|Claude|SseBroadcaster|EventSource|text/event-stream|tool-substrate|conversation-streaming|SendMessageInput|ConversationResponse" packages/core/src/index.ts` — no matches
- `rtk pnpm build` — passed
- `rtk pnpm exec tsc --noEmit -p packages/core` — passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core` — passed, 65 test files / 587 tests

## Readiness Impact

This card closes the Phase 3 public core export surface as
`implementation-ready`. It does not claim daemon, MCP, CLI, or live event
readiness; those remain Phase 4 responsibilities.
