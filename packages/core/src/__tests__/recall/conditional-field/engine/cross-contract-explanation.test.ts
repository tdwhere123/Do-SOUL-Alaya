import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSOCIATION_DOMAIN_ID,
  MemoryDimension,
  productSubjectId,
  type QueryInterpretation,
  type QueryProgram
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { capContractId } from "../../../../recall/conditional-field/cap-contract.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { traceDerivationForest } from "../../../../recall/conditional-field/engine/derivation-provenance.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { toSourceObserverRow, type ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import { MEM, WS, openSourceSlice } from "../vertical/source-slice.js";

const AS_OF = "2026-09-10T00:00:00.000Z";
const OPEN = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };

const SOFT = capContractId({
  domain_id: ASSOCIATION_DOMAIN_ID,
  normalization: "l2.dot.v1",
  transfer_id: "policy.cosine.linear.milligrade.v1",
  transfer_version: "1"
});
const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("contract-scoped explanations from admitted observation", () => {
  it("keeps B's own soft proof and drops a hard A→R→B splice", async () => {
    const { field, grounded, index } = await observeAndProject({
      stored: [MEM.r, MEM.l], nominate: [MEM.r, MEM.l], relation: [MEM.r, MEM.l]
    });
    expect(field.transitions.some((row) => row.applicable
      && productSubjectId(row.from) === MEM.r && productSubjectId(row.to) === MEM.l
      && row.cap_contract_id !== SOFT)).toBe(true);
    expect(field.seeds.some((seed) => productSubjectId(seed.state) === MEM.l && seed.cap_contract_id === SOFT)).toBe(true);
    const delivered = index.entries.find((entry) => entry.object_id === MEM.l);
    expect(delivered?.association_milligrades).toBeGreaterThan(0);
    const rootId = delivered?.explanation_ids[0];
    expect(rootId).toEqual(expect.any(String));
    expect(proofKinds(grounded, rootId!)).toEqual(["leaf"]);
    expect(proofMentions(grounded, rootId!, MEM.r)).toBe(false);
  });

  it("preserves a same-contract serial path to B", async () => {
    const { grounded, index } = await observeAndProject({
      stored: [MEM.r, MEM.l], nominate: [MEM.r, MEM.l], relation: [MEM.r, MEM.l], measure: false
    });
    const delivered = index.entries.find((entry) => entry.object_id === MEM.l);
    expect(delivered?.association_milligrades).toBeGreaterThan(0);
    const rootId = delivered?.explanation_ids[0];
    expect(rootId).toEqual(expect.any(String));
    expect(proofMentions(grounded, rootId!, MEM.r)).toBe(true);
  });

  it("leaves a hard-only destination unreachable after an applicable hard transfer", async () => {
    const { field, index } = await observeAndProject({
      stored: [MEM.r, MEM.c], nominate: [MEM.r], relation: [MEM.r, MEM.c]
    });
    const transferred = field.transitions.find((row) => row.applicable
      && productSubjectId(row.from) === MEM.r && productSubjectId(row.to) === MEM.c);
    expect(transferred).toBeDefined();
    expect(transferred?.cap_contract_id).not.toBe(SOFT);
    expect(field.seeds.some((seed) => productSubjectId(seed.state) === MEM.r && seed.cap_contract_id === SOFT)).toBe(true);
    const value = field.binding.kind === "bound"
      ? field.binding.snapshot.values.find((row) => productSubjectId(row.state) === MEM.c)
      : undefined;
    expect(value === undefined || value.activation?.kind === "unreachable"
      || (value.milligrades ?? 0) === 0).toBe(true);
    expect(index.entries.some((entry) => entry.object_id === MEM.c)).toBe(false);
  });

  it("denies an ineligible source by permission and by persisted currentness", async () => {
    const denied = await observeAndProject({
      stored: [MEM.r, MEM.l], nominate: [MEM.r, MEM.l], relation: [MEM.r, MEM.l],
      measure: false, authorizedScopes: ["global_core"]
    });
    expect(denied.index.entries.some((entry) => entry.object_id === MEM.l)).toBe(false);
    const stale = await observeAndProject({
      stored: [MEM.r, MEM.l], nominate: [MEM.r, MEM.l], relation: [MEM.r, MEM.l],
      measure: false, tombstone: MEM.l
    });
    expect(stale.index.entries.some((entry) => entry.object_id === MEM.l)).toBe(false);
  });

  it("resumes grounding with the same B explanation", async () => {
    const { field, grounded } = await observeAndProject({
      stored: [MEM.r, MEM.l], nominate: [MEM.r, MEM.l], relation: [MEM.r, MEM.l]
    });
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

async function observeAndProject(input: ObserveCase) {
  const field = await observeCase(input);
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
  readonly stored: readonly string[];
  readonly nominate: readonly string[];
  readonly relation: readonly [string, string];
  readonly measure?: boolean;
  readonly authorizedScopes?: readonly string[] | null;
  readonly tombstone?: string;
}>;

async function observeCase(input: ObserveCase) {
  const slice = await openSourceSlice((database) => databases.add(database));
  for (const objectId of input.stored) {
    const nominated = input.nominate.includes(objectId);
    await slice.writeMemory(objectId, nominated ? `related ${objectId}` : `other ${objectId}`, MemoryDimension.FACT);
  }
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000201",
    assertionId: `assert-${input.relation[0].slice(-4)}-${input.relation[1].slice(-4)}`,
    sourceId: input.relation[0],
    targetId: input.relation[1],
    resultObjectId: input.relation[1],
    relationKind: "observed_log",
    validity: OPEN,
    gist: "observed log"
  });
  if (input.tombstone !== undefined) {
    slice.database.connection.prepare(
      "UPDATE memory_entries SET retention_state='tombstoned' WHERE object_id=?"
    ).run(input.tombstone);
  }
  const measure = input.measure !== false;
  return observeField(interpretation(measure), {
    workspace_id: WS,
    query_text: "related",
    as_of: AS_OF,
    authorized_scopes: input.authorizedScopes === undefined ? null : input.authorizedScopes,
    budget: defaultBudget({ work_units: 10_000, memory_bytes: 1_000_000 }),
    readers: readersFor(slice, input.nominate, measure)
  });
}

function readersFor(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  nominate: readonly string[],
  measure: boolean
): ObserverReaders {
  return {
    lexical: (input) => slice.memoryReader.lexical(
      input.workspaceId, input.query, input.limit, input.nativeLimit, input.afterObjectId
    ),
    source: (input) => {
      const page = slice.memoryReader.source(input.workspaceId, input.objectId, input.byteLimit);
      return {
        row: page.row === null ? null : toSourceObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        unavailable: page.unavailable
      };
    },
    relation: (input) => slice.relationReader.read(
      input.workspaceId, input.subject, input.predicate, input.limit, input.nativeLimit, input.afterAssertionId
    ),
    ...(measure ? {
      embeddingIds: () => ({
        objectIds: [...nominate],
        rowVisits: nominate.length,
        metadataUtf8Bytes: 16,
        truncated: false,
        committedThrough: nominate.at(-1) ?? null
      }),
      measureStoredPair: ({ objectId }: { objectId: string }) => ({
        object: vector(objectId), query: vector("query"),
        objectStatus: "ready" as const, queryStatus: "ready" as const, rowVisits: 2, bytesRead: 16
      })
    } : {}),
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
  };
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
      relation_kind: "observed_log",
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

function vector(objectId: string) {
  const content = `related ${objectId}`;
  return {
    object_id: objectId,
    model_id: "stored-fixture",
    provider_kind: "openai" as const,
    schema_version: 1,
    dimensions: 2,
    content_hash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
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
