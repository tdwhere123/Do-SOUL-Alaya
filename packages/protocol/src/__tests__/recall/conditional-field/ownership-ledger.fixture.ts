export const OWNERSHIP_OWNERS = [
  "max-min-field",
  "tombstone-query-compiler",
  "tombstone-observers",
  "tombstone-field-engine",
  "tombstone-evidence",
  "tombstone-index",
  "tombstone-oracles",
  "tombstone-protocol-runtime",
  "durable-write-intent",
  "semantic-artifact-identity",
  "recall-projection-schema",
  "source-enrichment-runtime",
  "protocol-freeze",
  "query-compiler",
  "field-engine",
  "observers-and-readers",
  "production-index",
  "path-plasticity",
  "oracles-and-falsifiers",
  "protocol-runtime",
  "retired-deleted",
  "retained-exception"
] as const;

export type OwnershipOwner = (typeof OWNERSHIP_OWNERS)[number];

export type OwnershipClassification =
  | "already-written"
  | "reserved"
  | "reuse"
  | "reuse-gap"
  | "missing"
  | "unowned-live"
  | "transferred"
  | "retired-deleted"
  | "retained-exception";

export type OwnershipRow = Readonly<{
  readonly owner: OwnershipOwner;
  readonly paths: readonly string[];
  readonly classification: OwnershipClassification;
  readonly note: string;
}>;

export const ORDINARY_LANGUAGE_ADMISSION_STATUSES = [
  "resolved",
  "hypotheses",
  "partial",
  "unsupported",
  "malformed",
  "resource_rejected"
] as const;

export const OWNERSHIP_LEDGER: readonly OwnershipRow[] = Object.freeze([
  Object.freeze({
    owner: "max-min-field",
    classification: "already-written",
    note: "Graph max-min field, fair-work schedule, and leftover observer-index and source-slice tests.",
    paths: Object.freeze([
      "packages/graph-algorithms/src/max-min-field.ts",
      "packages/graph-algorithms/src/index.ts",
      "packages/graph-algorithms/src/__tests__/max-min-enumerate.ts",
      "packages/graph-algorithms/src/__tests__/max-min-field.test.ts",
      "packages/core/src/recall/conditional-field/reference/schedule-fair-work.ts",
      "packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.ts",
      "packages/core/src/__tests__/recall/conditional-field/reference/observer-index.test.ts",
      "packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.ts",
      "packages/core/src/__tests__/recall/conditional-field/vertical/source-to-index.test.ts"
    ])
  }),
  Object.freeze({
    owner: "tombstone-query-compiler",
    classification: "transferred",
    note: "Query compiler ownership moved to query-compiler.",
    paths: Object.freeze([])
  }),
  Object.freeze({
    owner: "tombstone-observers",
    classification: "transferred",
    note: "Observers and native readers moved to observers-and-readers.",
    paths: Object.freeze([])
  }),
  Object.freeze({
    owner: "tombstone-field-engine",
    classification: "transferred",
    note: "Field engine ownership moved to field-engine.",
    paths: Object.freeze([])
  }),
  Object.freeze({
    owner: "tombstone-evidence",
    classification: "transferred",
    note: "Evidence ownership moved to field-engine.",
    paths: Object.freeze([])
  }),
  Object.freeze({
    owner: "tombstone-index",
    classification: "transferred",
    note: "Index ownership moved to production-index.",
    paths: Object.freeze([])
  }),
  Object.freeze({
    owner: "tombstone-oracles",
    classification: "transferred",
    note: "Oracle and consumer acceptance moved to oracles-and-falsifiers.",
    paths: Object.freeze([])
  }),
  Object.freeze({
    owner: "tombstone-protocol-runtime",
    classification: "transferred",
    note: "Shared runner, MCP, CLI, and worker moved to protocol-runtime.",
    paths: Object.freeze([])
  }),
  Object.freeze({
    owner: "durable-write-intent",
    classification: "reuse",
    note: "Durable source/work intent already reviewed; not a parallel writer.",
    paths: Object.freeze([
      "packages/core/src/memory/memory-service/memory-write-service.ts",
      "packages/core/src/memory/source-write-garden-intent.ts",
      "packages/core/src/memory/evidence-create/create-evidence.ts",
      "packages/storage/src/repos/garden/garden-task-repo.ts"
    ])
  }),
  Object.freeze({
    owner: "semantic-artifact-identity",
    classification: "reuse",
    note: "Artifact identity retained; publication leaf lives with observers and bounded readers.",
    paths: Object.freeze([
      "packages/soul/src/garden/ingestion/official-api/semantic-artifact-identity.ts",
      "packages/protocol/src/garden/semantic-artifact.ts"
    ])
  }),
  Object.freeze({
    owner: "recall-projection-schema",
    classification: "reuse",
    note: "Projection schema retained; observablePin leaf lives with observers and bounded readers.",
    paths: Object.freeze([
      "packages/storage/src/repos/garden/indexed-recall-projection-schema.ts"
    ])
  }),
  Object.freeze({
    owner: "source-enrichment-runtime",
    classification: "reuse-gap",
    note: "Daemon enrich runtime retained; worker admission lives with observers and bounded readers.",
    paths: Object.freeze([
      "apps/core-daemon/src/garden/bulk-enrich/source-enrichment-runtime.ts",
      "apps/core-daemon/src/garden/bulk-enrich/bulk-enrich-runtime-runner.ts"
    ])
  }),
  Object.freeze({
    owner: "protocol-freeze",
    classification: "already-written",
    note: "Freeze record only; protocol leaves live with protocol-runtime.",
    paths: Object.freeze([])
  }),
  Object.freeze({
    owner: "query-compiler",
    classification: "reserved",
    note: "Query compiler, ordinary language, and interpret-query reference.",
    paths: Object.freeze([
      "packages/core/src/recall/conditional-field/query/",
      "packages/core/src/recall/conditional-field/reference/interpret-query.ts",
      "packages/core/src/__tests__/recall/conditional-field/query/",
      "packages/core/src/__tests__/recall/conditional-field/reference/interpret-query.test.ts"
    ])
  }),
  Object.freeze({
    owner: "field-engine",
    classification: "reserved",
    note: "Field engine, evidence, and max-min reference, including untracked engine leaves.",
    paths: Object.freeze([
      "packages/core/src/recall/conditional-field/engine/",
      "packages/core/src/recall/conditional-field/evidence/",
      "packages/core/src/recall/conditional-field/reference/bind-max-min.ts",
      "packages/core/src/__tests__/recall/conditional-field/engine/",
      "packages/core/src/__tests__/recall/conditional-field/evidence/",
      "packages/core/src/__tests__/recall/conditional-field/reference/bind-max-min.test.ts"
    ])
  }),
  Object.freeze({
    owner: "observers-and-readers",
    classification: "reserved",
    note: "Observers, bounded readers, snapshot pin, and enrichment publication leftovers.",
    paths: Object.freeze([
      "packages/core/src/recall/conditional-field/observers/",
      "packages/core/src/__tests__/recall/conditional-field/observers/",
      "packages/storage/src/repos/memory-entry/reads/bounded-recall-reader.ts",
      "packages/storage/src/repos/path/reads/relation-assertion/bounded-reader.ts",
      "packages/storage/src/repos/memory/reads/memory-embedding-bounded-read.ts",
      "packages/storage/src/__tests__/repos/memory-entry/reads/bounded-recall-cursor.test.ts",
      "packages/storage/src/__tests__/repos/path/reads/relation-assertion/bounded-reader-cursor.test.ts",
      "packages/storage/src/repos/garden/indexed-recall-projection.ts",
      "packages/storage/src/repos/garden/semantic-artifact-repo.ts",
      "packages/storage/src/__tests__/repos/garden/semantic-artifact-eligibility.test.ts",
      "packages/core/src/conversation/semantic-enrichment-worker.ts",
      "packages/core/src/__tests__/recall/local-vertical/artifact-lifecycle-fixture.ts",
      "packages/core/src/__tests__/recall/local-vertical/artifact-lifecycle-admission.test.ts"
    ])
  }),
  Object.freeze({
    owner: "production-index",
    classification: "reserved",
    note: "Production index is the single representation authority; accepting-projection is the index helper, not a second representation.",
    paths: Object.freeze([
      "packages/core/src/recall/conditional-field/index/",
      "packages/core/src/recall/conditional-field/reference/accepting-projection.ts",
      "packages/core/src/__tests__/recall/conditional-field/index/"
    ])
  }),
  Object.freeze({
    owner: "path-plasticity",
    classification: "reserved",
    note: "Attribution, plasticity, and necessity. MCP usage handler stays with protocol-runtime.",
    paths: Object.freeze([
      "packages/core/src/relations/path-plasticity/causal-usage-projection.ts",
      "packages/core/src/governance/effects/causal-plasticity.ts",
      "packages/soul/src/garden/materialization/path-plasticity-task.ts",
      "apps/core-daemon/src/garden/path-plasticity/path-plasticity-runtime.ts"
    ])
  }),
  Object.freeze({
    owner: "oracles-and-falsifiers",
    classification: "reserved",
    note: "Independent oracles and consumer falsifiers. No producer edits.",
    paths: Object.freeze([
      "packages/core/src/__tests__/recall/conditional-field-oracle/",
      "apps/core-daemon/src/__tests__/runtime/recall/conditional-field-acceptance/"
    ])
  }),
  Object.freeze({
    owner: "protocol-runtime",
    classification: "reserved",
    note: "Shared protocol, runner, worker/RPC, MCP/CLI, handbook.",
    paths: Object.freeze([
      "packages/protocol/src/recall/conditional-field/common.ts",
      "packages/protocol/src/recall/conditional-field/query.ts",
      "packages/protocol/src/recall/conditional-field/observer.ts",
      "packages/protocol/src/recall/conditional-field/field.ts",
      "packages/protocol/src/recall/conditional-field/support.ts",
      "packages/protocol/src/recall/conditional-field/index-view.ts",
      "packages/protocol/src/recall/conditional-field/feedback.ts",
      "packages/protocol/src/recall/conditional-field/index.ts",
      "packages/protocol/src/__tests__/recall/conditional-field/schema.test.ts",
      "packages/protocol/src/__tests__/recall/conditional-field/compatibility-ledger.fixture.ts",
      "packages/protocol/src/__tests__/recall/conditional-field/ownership-ledger.fixture.ts",
      "packages/protocol/src/__tests__/recall/conditional-field/upgrade-contract.test.ts",
      "packages/protocol/src/index.ts",
      "packages/protocol/src/surfaces/mcp-types.ts",
      "packages/core/src/index.ts",
      "packages/core/src/recall/recall-service.ts",
      "packages/core/src/recall/runtime/recall-service-runner.ts",
      "packages/core/src/recall/runtime/conditional-field-observe.ts",
      "packages/core/src/recall/runtime/recall-read-snapshot.ts",
      "packages/core/src/__tests__/recall/conditional-field/assembly/execute-recall.test.ts",
      "apps/core-daemon/src/runtime/recall-materialization/recall-materialization-recall-runtime.ts",
      "apps/core-daemon/src/runtime/recall-read-worker/",
      "apps/core-daemon/src/runtime/recall/recall-read-worker-client.ts",
      "apps/core-daemon/src/mcp-memory/recall/",
      "apps/core-daemon/src/mcp-memory/tool/tool-handler-dispatch.ts",
      "apps/core-daemon/src/mcp-memory/tool/tool-handler-types.ts",
      "apps/core-daemon/src/mcp-memory/tool/tool-catalog.ts",
      "apps/core-daemon/src/cli/tools.ts",
      "docs/handbook/recall.md",
      "docs/handbook/architecture.md",
      "docs/handbook/invariants.md",
      "docs/handbook/glossary.md",
      "docs/handbook/README.md",
      "scripts/ci/repository-structure-policy.json"
    ])
  }),
  Object.freeze({
    owner: "retired-deleted",
    classification: "retired-deleted",
    note: "Deleted retired decision/delivery and leftover ranking algorithms; not live Recall and not reserved-owner writes.",
    paths: Object.freeze([
      "packages/core/src/recall/decision/budget-aware-q/",
      "packages/core/src/recall/decision/query-proof/",
      "packages/core/src/recall/retrieval/indexed-family-read.ts",
      "packages/core/src/recall/delivery/canonical-delivery.ts",
      "packages/core/src/recall/coarse-filter/coarse-filter-pipeline.ts",
      "packages/core/src/recall/coarse-filter/coarse-filter.ts",
      "packages/core/src/recall/coarse-filter/coarse-filter-result.ts",
      "packages/core/src/recall/runtime/query/prepare-recall-request.ts",
      "packages/core/src/recall/runtime/query/prepare-recall-query-condition.ts",
      "packages/core/src/recall/field/family-rank-base.ts",
      "packages/core/src/recall/scoring/integrated-flood-scoring.ts",
      "packages/core/src/recall/scoring/flood-slice-axis.ts"
    ])
  }),
  Object.freeze({
    owner: "retained-exception",
    classification: "retained-exception",
    note: "field-contract SELECT_GAMMA_OPERATOR_ID is a generation-identity hash freeze, not a live walk.",
    paths: Object.freeze([
      "packages/protocol/src/recall/field-contract/"
    ])
  })
]);
