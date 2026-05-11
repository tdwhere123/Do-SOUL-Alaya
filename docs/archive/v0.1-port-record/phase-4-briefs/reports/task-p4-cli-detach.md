# Task P4-cli-detach Report

## Scope Compliance

- Card: `docs/v0.1/phase-4-briefs/task-p4-cli-detach.md`
- Port mode: `requires-redesign`
- Source / target: Alaya-original detach command in
  `apps/core-daemon/src/cli/detach.ts` using
  `apps/core-daemon/src/profile-mutation.ts`.
- Commit: `cc6d933`.

## Adapter Deviations

- Detach uses preview + explicit confirmation before removing Alaya
  MCP and `/alaya-inspect` profile entries.
- Reverse-attach writes go through the same audit-first profile
  mutation path as attach.

## Verification

- Covered by `gate-4-non-frontend-closeout.md`.
- Card-specific proof: `apps/core-daemon/src/__tests__/cli-detach.test.ts`.

## Readiness Impact

This command closes as `implementation-ready` and closes #BL-010 at
the non-frontend implementation level.
