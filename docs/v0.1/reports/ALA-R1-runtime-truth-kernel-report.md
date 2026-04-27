# ALA-R1 Runtime Truth Kernel Report

Status: closed for ALA-R1 package/runtime truth kernel baseline on 2026-04-27.

This report covers [ALA-R1 - Runtime Truth Kernel](../task-cards/runtime-truth-kernel.md).
It closes only the R1 package/runtime/storage/audit/doctor baseline. It does
not close any full-product, adapter, recall, provider, Inspector, or benchmark
surface.

## Scope Delivered

| Subcard | Delivered surface |
|---|---|
| ALA-R1.1 Package Runtime API Skeleton | Root `@do-soul/alaya` package with ESM TypeScript build, public `createAlayaRuntime(...)`, `AlayaRuntimePort`, runtime-owned `recordAuditedRuntimeDecision(...)` for `runtime.*` decision kinds, audited mutation error/report types, and doctor types. |
| ALA-R1.2 Storage Migration Baseline | Internal lazy `node:sqlite` storage initializes clean data dirs, `alaya_migrations`, and `alaya_audit_events`; migrations are idempotent. |
| ALA-R1.3 Audit-First Mutation Helper | Public `recordAuditedRuntimeDecision(...)` uses internal `executeAuditedMutation(...)`, which requires source/evidence and records intent before mutation, committed after mutation, and notification status after notify. |
| ALA-R1.4 Doctor Status Baseline | `alaya doctor --data-dir <path>` reports package/runtime/storage `ok`, profile/provider `not_implemented`, and `product_ready: false`. |

## Non-Goals Preserved

- Did not restore old prototype source.
- Did not import `@do-what/*` or `do-what-new/packages/*` runtime code.
- Did not implement MCP, CLI protocol fallback, Attach/Profile, Gateway, full
  ontology, recall, provider integration, Inspector, benchmark, daemon runtime,
  or agent usage proof.
- Did not expose storage as the adapter-facing API.

## Source Adaptation Note

The R1 audit ordering was adapted after inspecting the source-backed
`do-what-new` EventLog-first pattern. Alaya keeps the inherited intent ->
mutation -> notification ordering, but implements it as independent
`@do-soul/alaya` code because the source implementation is coupled to
`@do-what/protocol`, run hot state, and SSE broadcast wiring. No runtime import
from `@do-what/*` or `do-what-new/packages/*` was introduced.

## Verification Evidence

| Check | Command | Result |
|---|---|---|
| Dependency install | `rtk pnpm install` | passed; installed TypeScript, Vitest, and Node types. |
| Build | `rtk pnpm build` | passed. |
| Tests | `rtk pnpm test` | passed; 5 files, 21 tests. |
| Doctor smoke | `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-smoke` | passed; JSON reported package/runtime/storage `ok`, profile/provider `not_implemented`, `product_ready: false`. |
| Forbidden import scan | `rtk rg -n "@do-what/\|do-what-new/packages" package.json src` | no matches; command exited 1 because ripgrep found no matches. |
| Whitespace check | `rtk git diff --check` | passed. |

`node:sqlite` emitted Node's experimental warning during the CLI smoke. The
doctor JSON itself was stable on stdout; the warning does not claim product
readiness and remains an explicit R1 dependency tradeoff.

## Test Coverage

- `src/__tests__/storage.test.ts`: clean data-dir initialization and idempotent migration.
- `src/__tests__/audited-mutation.test.ts`: success ordering, mutation failure
  audit retention, notification failure, source/evidence rejection, and redaction.
- `src/__tests__/doctor-cli.test.ts`: runtime doctor report and CLI handler JSON.
- `src/__tests__/public-api-boundary.test.ts`: public exports and no storage
  export / no do-what runtime import scan.
- `src/__tests__/runtime-port.test.ts`: runtime-owned public
  `recordAuditedRuntimeDecision(...)` behavior, `runtime.*` kind enforcement,
  and source/evidence validation.

## Review Status

Closed after multi-lens review and fix-loop closure.

Findings fixed before closeout:

- Public runtime port no longer exposes caller-owned mutation callbacks.
- Public `DoctorReport` no longer imports storage implementation types.
- Public state-changing API is `recordAuditedRuntimeDecision(...)` for
  `runtime.*` decision kinds only.
- Doctor initialization failures return structured JSON instead of crashing.
- Secret redaction covers object keys, `Bearer`, `sk-*`, `key=value`,
  `key: value`, `key value`, `--key=value`, and `--key value` patterns,
  including `authorization`.
- Mutation-failure and notification-failure audit append failures preserve
  deterministic Alaya errors and committed notification semantics.
- Current docs/report indexes no longer outrun review closure and now match the
  final 5-file / 21-test verification result.

Final re-review status: correctness, architecture, red-team,
install/release, and spec/status reviewers returned `CLEAR` for their
Blocking and Important findings after the fix loop.
