# Implementation Brief: Task P4-secrets — Implement env and local-file secret references

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-secrets
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/core-daemon/src/secrets.ts`, `apps/core-daemon/src/__tests__/secrets.test.ts`
> - **Size**: S
> - **Prerequisite**: P4-daemon-startup-ordering, P4-cli-bridge
> - **Blocks**: P4-cli-doctor, Gate-4 demo
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-secrets";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21-§24` and `docs/handbook/architecture.md §Surface Shape`.

## 1. Background & Goal

**Background**: Alaya never stores plaintext secrets in its `.env`,
config files, or SQLite. Instead it persists secret-references that
get resolved at daemon boot. This decouples on-disk state from the
actual secret material so the same `alaya.toml` / `.env` can move
between machines without leaking keys, and so the daemon can fail
fast with a clear remediation message when a referenced secret is
missing. P4-cli-install writes secret-refs; the daemon entry point
resolves them.

**Goal**: A pure-function `resolveSecretRef(ref)` that turns a
well-formed secret-reference string into the secret value (or a
typed failure) plus the daemon-boot wiring that drives every config
field that holds a secret through it before the daemon trusts the
value.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/secrets.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/__tests__/secrets.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Behavior

**Secret-ref grammar (frozen for v0.1).**

```
secret-ref ::= env-ref | file-ref
env-ref    ::= "env:" identifier
file-ref   ::= "file:" absolute-path
identifier ::= [A-Za-z_][A-Za-z0-9_]*
```

Examples:
- `env:OPENAI_API_KEY` — read from `process.env.OPENAI_API_KEY`.
- `file:/home/alice/.config/alaya/secrets/openai` — read the entire
  file (UTF-8) and trim trailing whitespace.

The grammar is intentionally narrow. `keychain:...`,
`vault:...`, and other adapters are deferred to backlog #BL-009.

**Public surface.**

```ts
export type SecretRef = string;

export interface ResolvedSecret {
  readonly ref: SecretRef;
  readonly value: string;
  readonly origin: "env" | "file";
}

export type ResolveSecretError =
  | { kind: "malformed"; ref: SecretRef; reason: string }
  | { kind: "env_missing"; ref: SecretRef; var_name: string }
  | { kind: "file_missing"; ref: SecretRef; path: string }
  | { kind: "file_unreadable"; ref: SecretRef; path: string; cause: string }
  | { kind: "empty"; ref: SecretRef; origin: "env" | "file" };

export function resolveSecretRef(
  ref: SecretRef,
  reader?: SecretRefReader
): ResolvedSecret | ResolveSecretError;
```

`SecretRefReader` is a small interface that abstracts `process.env`
and `fs.readFile` so tests can inject deterministic readers without
touching the real environment. The default reader binds to the real
process.

**Resolution timing.** Secret-refs are resolved exactly once per
secret per daemon-boot, at startup step 2 (config load) of
`docs/handbook/architecture.md §Daemon Startup Ordering`, before any
service that consumes the secret is constructed. The resolved
plaintext lives only in process memory; it is never written back to
SQLite, EventLog, audit, or notifier payload. Tests MUST assert that
a resolved secret never appears in any persisted artifact.

**Error model.** `resolveSecretRef` is **fail-fast at boot**: if any
required secret-ref returns a `ResolveSecretError`, the daemon entry
prints a single human-readable remediation line per failure
(`OPENAI_API_KEY: env:OPENAI_API_KEY -> environment variable not
set`) and exits non-zero **before** the HTTP server, MCP server, or
Garden start. Optional secrets (e.g. embedding API key when the
embedding feature flag is off) MUST short-circuit before
`resolveSecretRef` is called; they do not become errors when absent.

**Logging hygiene.** No log line, no error message, and no audit
record may include the resolved plaintext value. The error model
returns the *ref* and a diagnostic, never the value.

**Where secret-ref strings are stored.** Secret-ref strings are
stored in the `<config-dir>/.env` file owned by P4-cli-install (one
per line, `KEY=secret-ref`). The daemon entry reads `.env`,
constructs the per-secret `ref`, and calls `resolveSecretRef`. SQLite
`app_config` does NOT hold secret-refs in v0.1; if a future card
needs workspace-scoped provider overrides, it must extend the schema
and the resolver in a follow-up card.

## 3. Deferred

- OS keychain adapter deferred to backlog #BL-009.
- Workspace-scoped secret-ref overrides (out of v0.1 scope; would
  require a follow-up card with schema migration).

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "secrets"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-secrets.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "secrets"`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-daemon-startup-ordering, P4-cli-bridge.
**Blocks**: P4-cli-doctor, Gate-4 demo.
