export const OWNERSHIP_CARDS = [
  "C00",
  "C01",
  "C02",
  "C03",
  "C04",
  "C05",
  "C06",
  "C07",
  "W00",
  "W01",
  "W02",
  "W03",
  "live-unowned"
] as const;

export type OwnershipCard = (typeof OWNERSHIP_CARDS)[number];

export type OwnershipClassification =
  | "already-written"
  | "reserved"
  | "reuse"
  | "reuse-gap"
  | "missing"
  | "unowned-live";

export type OwnershipRow = Readonly<{
  readonly card: OwnershipCard;
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
    card: "C00",
    classification: "already-written",
    note: "Frozen protocol leaves, reference binder, vertical slice, and contract tests.",
    paths: Object.freeze([
      "packages/protocol/src/recall/conditional-field/common.ts",
      "packages/protocol/src/recall/conditional-field/query.ts",
      "packages/protocol/src/recall/conditional-field/observer.ts",
      "packages/protocol/src/recall/conditional-field/field.ts",
      "packages/protocol/src/recall/conditional-field/support.ts",
      "packages/protocol/src/recall/conditional-field/index-view.ts",
      "packages/protocol/src/recall/conditional-field/index.ts",
      "packages/protocol/src/__tests__/recall/conditional-field/schema.test.ts",
      "packages/protocol/src/__tests__/recall/conditional-field/compatibility-ledger.fixture.ts",
      "packages/protocol/src/__tests__/recall/conditional-field/ownership-ledger.fixture.ts",
      "packages/graph-algorithms/src/max-min-field.ts",
      "packages/graph-algorithms/src/index.ts",
      "packages/graph-algorithms/src/__tests__/max-min-enumerate.ts",
      "packages/graph-algorithms/src/__tests__/max-min-field.test.ts",
      "packages/core/src/recall/conditional-field/reference/bind-max-min.ts",
      "packages/core/src/recall/conditional-field/reference/accepting-projection.ts",
      "packages/core/src/recall/conditional-field/reference/interpret-query.ts",
      "packages/core/src/recall/conditional-field/reference/schedule-fair-work.ts",
      "packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.ts",
      "packages/core/src/__tests__/recall/conditional-field/reference/bind-max-min.test.ts",
      "packages/core/src/__tests__/recall/conditional-field/reference/observer-index.test.ts",
      "packages/core/src/__tests__/recall/conditional-field/reference/interpret-query.test.ts",
      "packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.ts",
      "packages/core/src/__tests__/recall/conditional-field/vertical/source-to-index.test.ts"
    ])
  }),
  Object.freeze({
    card: "C01",
    classification: "reserved",
    note: "Ordinary-language compiler into the frozen QueryProgram; tests under the same tree.",
    paths: Object.freeze([
      "packages/core/src/recall/conditional-field/query/",
      "packages/core/src/__tests__/recall/conditional-field/query/"
    ])
  }),
  Object.freeze({
    card: "C02",
    classification: "reserved",
    note: "Additive cursors on the three native readers plus new observer runtime. W02 reuse leaves the cursor gap here.",
    paths: Object.freeze([
      "packages/storage/src/repos/memory-entry/reads/bounded-recall-reader.ts",
      "packages/storage/src/repos/path/reads/relation-assertion/bounded-reader.ts",
      "packages/storage/src/repos/memory/reads/memory-embedding-bounded-read.ts",
      "packages/core/src/recall/conditional-field/observers/",
      "packages/core/src/__tests__/recall/conditional-field/observers/"
    ])
  }),
  Object.freeze({
    card: "C03",
    classification: "reserved",
    note: "Production field engine over the C00 reference identities.",
    paths: Object.freeze([
      "packages/core/src/recall/conditional-field/engine/",
      "packages/core/src/__tests__/recall/conditional-field/engine/"
    ])
  }),
  Object.freeze({
    card: "C04",
    classification: "reserved",
    note: "Evidence and support owner for the conditional field.",
    paths: Object.freeze([
      "packages/core/src/recall/conditional-field/evidence/",
      "packages/core/src/__tests__/recall/conditional-field/evidence/"
    ])
  }),
  Object.freeze({
    card: "C05",
    classification: "reserved",
    note: "Production index and representation owner.",
    paths: Object.freeze([
      "packages/core/src/recall/conditional-field/index/",
      "packages/core/src/__tests__/recall/conditional-field/index/"
    ])
  }),
  Object.freeze({
    card: "C06",
    classification: "reserved",
    note: "Independent oracle and daemon acceptance tests. Must not import the graph-algorithms enumerator.",
    paths: Object.freeze([
      "packages/core/src/__tests__/recall/conditional-field-oracle/",
      "apps/core-daemon/src/__tests__/runtime/recall/conditional-field-acceptance/"
    ])
  }),
  Object.freeze({
    card: "C07",
    classification: "reserved",
    note: "Shared barrels after C00, MCP/CLI, executeRecall runner, and repository-structure policy. executeRecall is missing until this card.",
    paths: Object.freeze([
      "packages/protocol/src/index.ts",
      "packages/protocol/src/surfaces/mcp-types.ts",
      "packages/core/src/index.ts",
      "packages/core/src/recall/recall-service.ts",
      "packages/core/src/recall/runtime/recall-service-runner.ts",
      "apps/core-daemon/src/runtime/recall-materialization/recall-materialization-recall-runtime.ts",
      "apps/core-daemon/src/runtime/recall-read-worker/",
      "apps/core-daemon/src/runtime/recall/recall-read-worker-client.ts",
      "apps/core-daemon/src/mcp-memory/recall/",
      "apps/core-daemon/src/mcp-memory/tool/tool-handler-dispatch.ts",
      "apps/core-daemon/src/mcp-memory/tool/tool-handler-types.ts",
      "apps/core-daemon/src/mcp-memory/tool/tool-catalog.ts",
      "apps/core-daemon/src/cli/tools.ts",
      "scripts/ci/repository-structure-policy.json"
    ])
  }),
  Object.freeze({
    card: "W00",
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
    card: "W01",
    classification: "reuse",
    note: "Artifact identity/repo reuse. Semantic worker and source-enrichment runtime gap is W03.",
    paths: Object.freeze([
      "packages/soul/src/garden/ingestion/official-api/semantic-artifact-identity.ts",
      "packages/storage/src/repos/garden/semantic-artifact-repo.ts",
      "packages/protocol/src/garden/semantic-artifact.ts"
    ])
  }),
  Object.freeze({
    card: "W02",
    classification: "reuse",
    note: "Incremental projection reuse. Native reader cursor gap is C02.",
    paths: Object.freeze([
      "packages/storage/src/repos/garden/indexed-recall-projection.ts",
      "packages/storage/src/repos/garden/indexed-recall-projection-schema.ts"
    ])
  }),
  Object.freeze({
    card: "W03",
    classification: "reuse-gap",
    note: "Semantic worker plus source-enrichment runtime remaining from W01.",
    paths: Object.freeze([
      "packages/core/src/conversation/semantic-enrichment-worker.ts",
      "apps/core-daemon/src/garden/bulk-enrich/source-enrichment-runtime.ts",
      "apps/core-daemon/src/garden/bulk-enrich/bulk-enrich-runtime-runner.ts"
    ])
  }),
  Object.freeze({
    card: "live-unowned",
    classification: "unowned-live",
    note: "Existing live trees stay out of the parallel-card write set.",
    paths: Object.freeze([
      "packages/core/src/recall/decision/budget-aware-q/",
      "packages/core/src/recall/decision/query-proof/",
      "packages/protocol/src/recall/field-contract/",
      "packages/core/src/recall/retrieval/indexed-family-read.ts",
      "packages/core/src/recall/delivery/canonical-delivery.ts"
    ])
  })
]);
