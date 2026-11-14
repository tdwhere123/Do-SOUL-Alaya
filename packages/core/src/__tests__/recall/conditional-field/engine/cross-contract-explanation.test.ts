import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSOCIATION_DOMAIN_ID,
  productSubjectId,
  type QueryInterpretation,
  type QueryProgram,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import {
  SqliteFieldSourceRecordRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { capContractId } from "../../../../recall/conditional-field/cap-contract.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { traceDerivationForest } from "../../../../recall/conditional-field/engine/derivation-provenance.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import { hashedRecord, openFieldDatabase } from "../../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";

const AS_OF = "2026-09-10T00:00:00.000Z";
const VALIDITY: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const CONTENT = "retained source";
const CONTENT_HASH = `sha256:${createHash("sha256").update(CONTENT).digest("hex")}`;
const SOFT = capContractId({
  domain_id: ASSOCIATION_DOMAIN_ID,
  normalization: "l2.dot.v1",
  transfer_id: "policy.cosine.linear.milligrade.v1",
  transfer_version: "1"
});
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("contract-scoped explanations from admitted observation", () => {
  it("keeps B's own soft proof and drops a hard A→R→B splice", () => {
    const { field, grounded, index } = observeAndProject({ objects: ["A", "B"], relation: ["A", "B"] });
    expect(field.transitions.some((row) => row.applicable
      && productSubjectId(row.from) === "A" && productSubjectId(row.to) === "B"
      && row.cap_contract_id !== SOFT)).toBe(true);
    expect(field.seeds.some((seed) => productSubjectId(seed.state) === "B" && seed.cap_contract_id === SOFT)).toBe(true);
    const delivered = index.entries.find((entry) => entry.object_id === "B");
    expect(delivered?.association_milligrades).toBeGreaterThan(0);
    const rootId = delivered?.explanation_ids[0];
    expect(rootId).toEqual(expect.any(String));
    expect(proofKinds(grounded, rootId!)).toEqual(["leaf"]);
    expect(proofMentions(grounded, rootId!, "A")).toBe(false);
  });

  it("preserves a same-contract serial path to B", () => {
    const { grounded, index } = observeAndProject({
      objects: ["A", "B"], relation: ["A", "B"], measure: false
    });
    const delivered = index.entries.find((entry) => entry.object_id === "B");
    expect(delivered?.association_milligrades).toBeGreaterThan(0);
    const rootId = delivered?.explanation_ids[0];
    expect(rootId).toEqual(expect.any(String));
    expect(proofMentions(grounded, rootId!, "A")).toBe(true);
  });

  it("leaves a hard-only destination unreachable", () => {
    const { field, index } = observeAndProject({ objects: ["A"], relation: ["A", "C"] });
    const value = field.binding.kind === "bound"
      ? field.binding.snapshot.values.find((row) => productSubjectId(row.state) === "C")
      : undefined;
    expect(value === undefined || value.activation?.kind === "unreachable"
      || (value.milligrades ?? 0) === 0).toBe(true);
    expect(index.entries.some((entry) => entry.object_id === "C")).toBe(false);
  });

  it("denies an ineligible source by permission and by currentness", () => {
    const denied = observeAndProject({
      objects: ["A", "B"], relation: ["A", "B"], authorizedScopes: []
    });
    expect(denied.index.entries.some((entry) => entry.object_id === "B")).toBe(false);
    const stale = observeAndProject({
      objects: ["A", "B"], relation: ["A", "B"], staleObject: "B"
    });
    expect(stale.index.entries.some((entry) => entry.object_id === "B")).toBe(false);
  });

  it("resumes grounding with the same B explanation", () => {
    const { field, grounded } = observeAndProject({ objects: ["A", "B"], relation: ["A", "B"] });
    const input = {
      seeds: field.seeds, transitions: field.transitions, derivations: field.derivations,
      transition_derivations: field.transition_derivations
    };
    let progress = undefined as ReturnType<typeof groundedOutputDerivations>["progress"] | undefined;
    let paged;
    for (let attempt = 0; attempt < grounded.work + 20; attempt += 1) {
      paged = groundedOutputDerivations({ ...input, allowance: 1, progress });
      progress = paged.progress;
      if (paged.complete) break;
    }
    expect(paged?.complete).toBe(true);
    expect(paged?.roots).toEqual(grounded.roots);
  });
});

function observeAndProject(input: ObserveCase) {
  const field = observeCase(input);
  return { field, ...projectField(field) };
}

function projectField(field: ReturnType<typeof observeField>) {
  if (field.binding.kind !== "bound") throw new Error("field binding rejected");
  const grounded = groundedOutputDerivations({
    seeds: field.seeds, transitions: field.transitions, derivations: field.derivations,
    transition_derivations: field.transition_derivations, allowance: 10_000
  });
  const index = projectAcceptingIndex({
    snapshot: field.binding.snapshot,
    query_id: field.query_id,
    snapshot_id: SNAPSHOT_ID,
    result_version: "v1",
    view: defaultView(),
    budget: defaultBudget({ finalization_reserve: 100 }),
    derivations: grounded.derivations,
    output_derivations: grounded.roots,
    grounding_complete: grounded.complete
  });
  return { grounded, index };
}

type ObserveCase = Readonly<{
  readonly objects: readonly string[];
  readonly relation: readonly [string, string];
  readonly measure?: boolean;
  readonly authorizedScopes?: readonly string[] | null;
  readonly staleObject?: string;
  readonly workUnits?: number;
  readonly resume?: ReturnType<typeof observeField>;
}>;

function observeCase(input: ObserveCase) {
  const database = openFieldDatabase();
  tracked.add(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  for (const objectId of input.objects) {
    records.insert(hashedRecord("workspace-1", CONTENT, objectId));
  }
  const measure = input.measure !== false;
  return observeField(interpretation(measure), {
    workspace_id: "workspace-1",
    query_text: "related",
    as_of: AS_OF,
    authorized_scopes: input.authorizedScopes === undefined ? null : input.authorizedScopes,
    budget: defaultBudget({ work_units: input.workUnits ?? 10_000, memory_bytes: 1_000_000 }),
    ...(input.resume === undefined ? {} : { resume_field: input.resume }),
    readers: {
      lexical: () => ({
        ids: measure ? [] : [...input.objects],
        nativeVisits: measure ? 0 : input.objects.length,
        nativeBytes: 1,
        rowsRead: measure ? 0 : input.objects.length,
        bytesRead: 1,
        truncated: false
      }),
      source: ({ objectId }) => sourcePage(records, objectId, input.staleObject),
      ...(measure ? {
        embeddingIds: () => ({
          objectIds: [...input.objects],
          rowVisits: input.objects.length,
          metadataUtf8Bytes: 16,
          truncated: false,
          committedThrough: input.objects.at(-1) ?? null
        }),
        measureStoredPair: ({ objectId }: { objectId: string }) => ({
          object: vector(objectId), query: vector("query"),
          objectStatus: "ready" as const, queryStatus: "ready" as const, rowVisits: 2, bytesRead: 16
        })
      } : {}),
      relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) =>
        relationPage(input.relation, subject, predicate, afterAssertionId, limit, nativeLimit)
    }
  });
}

function interpretation(measure: boolean): QueryInterpretation {
  const program: QueryProgram = {
    schema_version: 1,
    kind: "closure",
    product_state_sufficient: true,
    local_variables: ["s", "t"],
    body: {
      schema_version: 1,
      kind: "relation",
      relation_kind: "related",
      source_variable: "s",
      target_variable: "t",
      guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none" },
      facet_mode: "same_path",
      threshold_milligrades: 0
    }
  };
  return {
    schema_version: 1,
    query_id: "cross-contract-admitted",
    snapshot_id: SNAPSHOT_ID,
    status: "resolved",
    holes: [],
    hypotheses: [],
    view: defaultView(),
    program,
    ...(measure ? {
      interpretation_proposal: {
        schema_version: 1 as const,
        original_query_digest: `sha256:${"a".repeat(64)}`,
        producer_id: "alaya.query.proposal.core.v1",
        stored_cosine_admission: {
          registry_version: "stored.cosine.admission.v1" as const,
          join: "any" as const,
          obligations: [{
            obligation_id: "stored-fixture",
            producer_id: "stored.cosine.pair.v1",
            model_id: "stored-fixture",
            provider_kind: "openai" as const,
            schema_version: 1 as const,
            dimensions: 2,
            domain: "cosine.unit.v1",
            normalization: "l2.dot.v1",
            raw_threshold: 0.5,
            transfer_id: "policy.cosine.linear.milligrade.v1",
            transfer_version: "1",
            policy_defined: true
          }]
        }
      }
    } : {})
  };
}

function sourcePage(records: SqliteFieldSourceRecordRepo, objectId: string, staleObject: string | undefined) {
  const stored = records.findCurrent("workspace-1", objectId);
  if (stored?.source_body == null) {
    return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true as const };
  }
  const stale = objectId === staleObject;
  return {
    row: {
      object_id: objectId,
      sourceRevision: stored.source_version,
      content: stored.source_body,
      lifecycle_state: stale ? "retired" : "active",
      scope_class: "project" as const,
      ...(stale ? { valid_from: "2020-01-01T00:00:00.000Z", valid_to: "2020-01-02T00:00:00.000Z" } : {})
    },
    rowsRead: 1,
    bytesRead: stored.source_body.length,
    unavailable: false
  };
}

function relationPage(
  relation: readonly [string, string],
  subject: string | null,
  predicate: string,
  afterAssertionId: string | null,
  limit: number,
  nativeLimit: number
) {
  const assertionId = `assert-${relation[0]}-${relation[1]}`;
  const rows = subject === relation[0] && predicate === "related" && assertionId > (afterAssertionId ?? "")
    ? [{
      sourceObjectId: relation[0],
      targetObjectId: relation[1],
      predicate: "related",
      assertionId,
      resultObjectId: relation[1],
      validity: VALIDITY,
      evidenceRefs: [`evidence-${assertionId}`]
    }]
    : [];
  const observations = rows.slice(0, Math.min(limit, nativeLimit));
  return {
    observations,
    nativeVisits: observations.length,
    nativeBytes: 1,
    rowsRead: observations.length,
    bytesRead: 1,
    truncated: false,
    committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId
  };
}

function vector(objectId: string) {
  return {
    object_id: objectId,
    model_id: "stored-fixture",
    provider_kind: "openai" as const,
    schema_version: 1,
    dimensions: 2,
    content_hash: CONTENT_HASH,
    embedding: new Float32Array([1, 0])
  };
}

function proofKinds(grounded: ReturnType<typeof groundedOutputDerivations>, rootId: string): readonly string[] {
  const forest = new Map(grounded.derivations.map((row) => [row.derivation_id, row]));
  return [...traceDerivationForest({ forest, roots: [rootId] }).traversal.nodes.values()]
    .map((row) => row.kind).sort();
}

function proofMentions(
  grounded: ReturnType<typeof groundedOutputDerivations>,
  rootId: string,
  observationId: string
): boolean {
  const forest = new Map(grounded.derivations.map((row) => [row.derivation_id, row]));
  return [...traceDerivationForest({ forest, roots: [rootId] }).traversal.nodes.values()]
    .some((row) => row.observation_ids.includes(observationId));
}

