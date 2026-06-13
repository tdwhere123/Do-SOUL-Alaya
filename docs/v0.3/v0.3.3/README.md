# v0.3.3 Patch — Quality Recall And Keychain Hygiene

v0.3.3 is a patch-internal quality release. It tightens recall graph
signals, makes bootstrap reconciliation honest for workspaces that have
no configured PathRelation templates, adds graph-health diagnostics to
`alaya doctor`, and finishes keychain install hygiene without changing
public MCP tools, protocol schemas, EventLog payload schemas, runtime
config schemas, or storage migrations.

## Version Boundary

v0.3.3 remains patch-internal. It does not touch:

- MCP tool names, descriptions, request schemas, or response schemas;
- protocol zod schemas;
- EventLog payload schemas;
- runtime control-plane config schemas;
- SQLite migrations.

The release changes internal daemon/core behavior and CLI diagnostics.
Any future work that turns graph health or bootstrap templates into a
public contract must cite invariant 25 and rerun the SemVer snapshot path.

## Slices

| Slice | Scope | Status |
|---|---|---|
| 1 | Persist `RECALLS` memory graph edges from used recall reports and read weighted graph support in later recall | review-clean |
| 2 | Reconcile bootstrap paths for existing active workspaces and make corrupt partial state visible | review-clean |
| 3 | Reallocate cold graph/path recall weight to relevance and expose advisory graph health in `alaya doctor` | review-clean |
| 4 | Documentation honesty and v0.3.3 closeout | review-clean |
| 5 | Keychain real-issue fixes: timeout, parsing, doctor resolution, orphan-audit remediation | review-clean |
| 6 | Keychain engineering hygiene and install split | review-clean |

## Bootstrap Default Semantics

`apps/core-daemon/src/runtime/daemon-defaults.ts` intentionally ships
`defaultBootstrappingTemplates` as an empty list. PathRelation rows are
ontology structure, not daemon filler. A daemon startup or
`alaya doctor --reconcile-bootstrap` run with no configured templates
returns `skipped_no_templates` and does not create path rows,
bootstrapping records, or planted events.

`BootstrappingService` still supports explicitly provided templates.
That keeps the planner testable and leaves room for a future explicit
ontology/config source without smuggling ontology defaults through
`apps/core-daemon`.

Zero-day policy defaults are a separate runtime security concern. They
remain driven by `ZERO_DAY_POLICIES_JSON` through the zero-day policy
loader and security layer; v0.3.3 does not express them as memory
object defaults or PathRelation bootstrap seeds.

## Required Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-core -- recall-8factor recall-with-edges workspace-service
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- recall-cross-link workspace-bootstrap-reconcile cli-doctor graph-health-service cli-register daemon-runtime-helpers
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- cli-install install-keychain-migration keychain-adapters doctor-garden-compute-resolve
rtk pnpm exec vitest run --project @do-soul/alaya-soul -- bootstrapping-service
rtk pnpm exec vitest run --project @do-soul/alaya-storage -- bootstrapping-record-repo
rtk pnpm exec vitest run --project @do-soul/alaya-protocol -- runtime-governance-events
rtk pnpm build
rtk pnpm test
rtk git diff --check
```
