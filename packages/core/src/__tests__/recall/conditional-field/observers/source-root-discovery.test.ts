import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type Guard,
  type QueryInterpretation,
  type QueryProgram,
  type SnapshotReadLease
} from "@do-soul/alaya-protocol";
import { buildTypedObservation } from "../../../../recall/conditional-field/observers/observation-admission.js";
import {
  observeConditionalField,
  startObserverCursor,
  type SourceRootObserverRow
} from "../../../../recall/conditional-field/observers/observe.js";
import {
  QUERY_ID,
  SNAPSHOT_ID,
  defaultView
} from "../reference/deployment.fixture.js";

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;
const NL_QUERY = "show me yesterday's failed deployment";
const ROOT_BODY = "deployment to service-x failed at 12:01";
const LATER_NEEDLE = "needle-only-after-first-chunk";

describe("source-root discovery admission", () => {
  it("nominates a source root that does not contain the full NL query", () => {
    const root = sourceRoot({ content: ROOT_BODY, content_complete: true });
    const observed = observeConditionalField(seedInput(
      interpretation(relation("observed_log", "r", "l")),
      [root],
      NL_QUERY
    ));
    expect(ROOT_BODY.includes(NL_QUERY)).toBe(false);
    expect(observed.page.observations.some((row) => row.object_id === root.root_id)).toBe(true);
    expect(observed.page.outcome.status).not.toBe("unavailable");
  });

  it("keeps an incomplete first-chunk literal miss as residual membership", () => {
    const root = sourceRoot({
      content: ROOT_BODY,
      content_complete: false
    });
    const observed = observeConditionalField(seedInput(
      interpretation(relation("observed_log", "r", "l", {
        kind: "query_predicate",
        predicate_name: "source.literal.nfc.v1",
        entity_id: LATER_NEEDLE,
        variable: "r"
      })),
      [root],
      NL_QUERY
    ));
    const row = observed.page.observations.find((item) => item.object_id === root.root_id);
    expect(row).toBeDefined();
    expect(row?.applicability.verdict).toBe("unresolved");
    expect(observed.page.outcome.status).toBe("interrupted");
    expect(observed.page.outcome.status).not.toBe("exhausted");
    expect(observed.work.residual_work_units).toBeGreaterThan(0);
  });

  it("does not let an epsilon alternative admit a complete literal miss", () => {
    const root = sourceRoot({ content: ROOT_BODY, content_complete: true });
    const observed = observeConditionalField(seedInput(
      interpretation({
        schema_version: SCHEMA,
        kind: "alternative",
        options: [
          { schema_version: SCHEMA, kind: "epsilon" },
          relation("observed_log", "r", "l", {
            kind: "query_predicate",
            predicate_name: "source.literal.nfc.v1",
            entity_id: LATER_NEEDLE,
            variable: "r"
          })
        ]
      }),
      [root],
      NL_QUERY
    ));
    expect(observed.page.observations.some((row) => row.object_id === root.root_id)).toBe(false);
    expect(observed.page.outcome.status).toBe("exhausted");
  });

  it("treats a complete literal miss as absence", () => {
    const root = sourceRoot({ content: ROOT_BODY, content_complete: true });
    const observed = observeConditionalField(seedInput(
      interpretation(relation("observed_log", "r", "l", {
        kind: "query_predicate",
        predicate_name: "source.literal.nfc.v1",
        entity_id: LATER_NEEDLE,
        variable: "r"
      })),
      [root],
      NL_QUERY
    ));
    expect(observed.page.observations.some((row) => row.object_id === root.root_id)).toBe(false);
    expect(observed.page.outcome.status).toBe("exhausted");
  });

  it("seeds a two-relation program when the root satisfies only its own guard", () => {
    const root = sourceRoot({ role: "user", content: ROOT_BODY, content_complete: true });
    const observation = buildTypedObservation(observeInput(twoRelationProgram()), {
      objectId: root.root_id,
      sourceRevision: root.revision,
      observationKey: root.root_id,
      sourceRoot: root,
      identityKind: "object"
    });
    expect(observation).not.toBeNull();
    expect(observation?.applicability.verdict).toBe("true");
  });

  it("does not drop a seed under a proposal equality about another object", () => {
    const root = sourceRoot({ content: ROOT_BODY, content_complete: true });
    const observation = buildTypedObservation(observeInput(relation("observed_log", "r", "l"), {
      interpretation_proposal: {
        schema_version: SCHEMA,
        original_query_digest: SNAPSHOT_ID,
        producer_id: "alaya.query.proposal.core.v1",
        conditions: [{
          schema_version: SCHEMA,
          kind: "equality",
          variable: "c",
          equals_variable: "l",
          time_scope: "none"
        }]
      }
    }), {
      objectId: root.root_id,
      sourceRevision: root.revision,
      observationKey: root.root_id,
      sourceRoot: root,
      identityKind: "object"
    });
    expect(observation).not.toBeNull();
    expect(observation?.applicability.verdict).toBe("true");
  });

  it("marks an applicable unhandled guard unresolved rather than true", () => {
    const root = sourceRoot({ content: ROOT_BODY, content_complete: true });
    const observation = buildTypedObservation(observeInput(relation("observed_log", "r", "l", {
      kind: "equality",
      variable: "r",
      equals_variable: "l"
    })), {
      objectId: root.root_id,
      sourceRevision: root.revision,
      observationKey: root.root_id,
      sourceRoot: root,
      identityKind: "object"
    });
    expect(observation).not.toBeNull();
    expect(observation?.applicability.kind).toBe("equality");
    expect(observation?.applicability.verdict).toBe("unresolved");
    expect(observation?.applicability.verdict).not.toBe("true");
  });
});

function twoRelationProgram(): QueryProgram {
  return {
    schema_version: SCHEMA,
    kind: "sequence",
    steps: [
      relation("observed_log", "r", "l", {
        kind: "query_predicate",
        predicate_name: "source.role.v1",
        entity_id: "user",
        variable: "r"
      }),
      relation("config_direct", "l", "c", {
        kind: "query_predicate",
        predicate_name: "source.identity.v1",
        entity_id: "config-root",
        variable: "c"
      })
    ]
  };
}

function seedInput(
  query: QueryInterpretation,
  rows: readonly SourceRootObserverRow[],
  seedQuery: string
) {
  return {
    lease: lease(),
    action: {
      schema_version: SCHEMA,
      action: "seed" as const,
      region_id: "seed",
      work_limit: 16
    },
    cursor: startObserverCursor({
      cursor_id: "seed",
      snapshot_id: SNAPSHOT_ID,
      query_id: query.query_id,
      region_id: "seed"
    }),
    query,
    workspace_id: "ws",
    seed_query: seedQuery,
    authorized_scopes: null,
    readers: {
      sourceRoots: () => ({
        rows,
        nativeVisits: rows.length,
        nativeBytes: 8,
        rowsRead: rows.length,
        bytesRead: 8,
        truncated: false,
        committedThrough: rows.at(-1)?.root_id ?? null
      })
    }
  };
}

function observeInput(
  program: QueryProgram,
  extra: Partial<QueryInterpretation> = {}
) {
  return {
    lease: lease(),
    action: {
      schema_version: SCHEMA,
      action: "seed" as const,
      region_id: "seed",
      work_limit: 16
    },
    cursor: startObserverCursor({
      cursor_id: "seed",
      snapshot_id: SNAPSHOT_ID,
      query_id: QUERY_ID,
      region_id: "seed"
    }),
    query: interpretation(program, extra),
    workspace_id: "ws",
    readers: {},
    authorized_scopes: null,
    seed_query: NL_QUERY
  };
}

function interpretation(
  program: QueryProgram,
  extra: Partial<QueryInterpretation> = {}
): QueryInterpretation {
  return {
    schema_version: SCHEMA,
    query_id: QUERY_ID,
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program,
    view: { ...defaultView(), result_kind_view: "source_only" },
    holes: [],
    hypotheses: [],
    ...extra
  };
}

function relation(
  relationKind: string,
  source: string,
  target: string,
  guard: Partial<Guard> = {}
): Extract<QueryProgram, { readonly kind: "relation" }> {
  return {
    schema_version: SCHEMA,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: source,
    target_variable: target,
    guard: {
      schema_version: SCHEMA,
      kind: guard.kind ?? "query_predicate",
      verdict: "unresolved",
      variable: guard.variable ?? source,
      time_scope: guard.time_scope ?? "none",
      ...(guard.equals_variable === undefined ? {} : { equals_variable: guard.equals_variable }),
      ...(guard.predicate_name === undefined ? {} : { predicate_name: guard.predicate_name }),
      ...(guard.entity_id === undefined ? {} : { entity_id: guard.entity_id })
    },
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}

function sourceRoot(overrides: Partial<SourceRootObserverRow> = {}): SourceRootObserverRow {
  return {
    kind: "source_record",
    workspace_id: "ws",
    root_id: "root-deploy",
    revision: "rev-1",
    digest: SNAPSHOT_ID,
    evidence_object_id: "capsule-1",
    ...overrides
  };
}

function lease(): SnapshotReadLease {
  return {
    schema_version: SCHEMA,
    lease_id: "lease-1",
    snapshot_id: SNAPSHOT_ID,
    query_id: QUERY_ID,
    status: "active"
  };
}
