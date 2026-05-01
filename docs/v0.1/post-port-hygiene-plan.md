# Post-Port Hygiene Plan

> - **Status**: frozen plan; do not execute before the final v0.1 port card lands
> - **Backlog**: `#BL-016`, `#BL-017`
> - **Earliest start**: after `P5-graph-contract` and `P5-final-review` close
> - **Port posture**: post-port cleanup; every divergence from
>   `vendor/do-what-new-snapshot/` must be explicit

## Goal

Close the port residue intentionally left in place by v0.1 Port-First
discipline without mixing cleanup into active port cards.

## Non-Goals

- Do not change runtime behavior.
- Do not rename event wire values such as `soul.green.pierced`.
- Do not edit `vendor/do-what-new-snapshot/`.
- Do not begin before the final v0.1 port card lands.

## Slices

| Slice | Scope | Files | Verification |
|---|---|---|---|
| H1 event-domain naming | Rename `packages/protocol/src/events/phase-*.ts` files and exported `Phase*EventType` symbols to domain names while preserving event string values. | `packages/protocol/src/events/`, protocol tests, import call sites | `rtk pnpm exec vitest run --project @do-soul/alaya-protocol events` |
| H2 oversized-file split | Split inherited oversized files into focused modules without behavior changes. Start with files over 800 lines. | `packages/protocol/src/events/phase-c.ts` and any peer files found by size sweep | `rtk pnpm build`; targeted protocol tests |
| H3 unused export cleanup | Remove Alaya-unused exports and duplicate adapter helpers left by port shims. | `packages/*/src/index.ts`, package-local call sites | `rtk pnpm build`; package-level vitest |
| H4 adapter residue cleanup | Remove dead branches for upstream-only GUI/TUI/SSE surfaces that Alaya never exercises. | `apps/core-daemon/src/`, `packages/core/src/`, docs references found by sweep | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon`; docs sweep |
| H5 docs map refresh | Refresh ownership maps and runtime status after cleanup lands. | `docs/handbook/code-map.md`, `docs/handbook/runtime-status.md`, affected task cards | `rtk rg -n "Phase[0-9A-Za-z]*EventType|phase-.*events|schema-ready|implementation-ready|mcp-consumable" docs packages apps` |

## Acceptance

- `#BL-016` closes only after event file names, exported type names,
  tests, and call sites use domain-aligned names while wire event
  strings remain compatible.
- `#BL-017` closes only after every slice above lands, docs are
  updated, and `rtk pnpm build` plus full `rtk pnpm test` pass.
- If any slice requires behavior change, stop and open a new numbered
  backlog issue instead of smuggling it into hygiene.
