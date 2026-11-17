import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../../../../../../scripts/test-support/provider-free/strict-provider-free-boundary.js");
  const safe = installProviderFreeBoundary();
  const strict = installStrictProviderFreeBoundary();
  return { safe, strict };
});
afterAll(() => {
  try { expect(isolation.safe.violations).toEqual([]); expect(isolation.strict.forbidden).toEqual([]); }
  finally { isolation.strict.restore(); isolation.safe.restore(); }
});
import {
  ASSOCIATION_DOMAIN_ID,
  MemoryDimension,
  productSubjectId,
  type QueryInterpretation,
  type QueryProgram
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { capContractId, hardIdentityCapContractId } from "../../../../recall/conditional-field/cap-contract.js";
import { compileConditionalFieldQuery, digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query.js";
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
  expect(isolation.safe.violations).toEqual([]);
  expect(isolation.strict.forbidden).toEqual([]);
});

describe("contract-scoped explanations from admitted observation", () => {
  it("retains independent lexical and measured alternatives through an admitted Hard relation", async () => {
    const { field, grounded, index } = await observeAndProject({
      stored: [MEM.r, MEM.l], nominate: [MEM.r, MEM.l], relation: [MEM.r, MEM.l]
    });
    expect(field.seeds.some(seed => seed.cap_contract_id === SOFT && seed.milligrades === 800)).toBe(true);
    expect(grounded.derivations.some(row => row.kind === "leaf" && row.association_milligrades === 800)).toBe(true);
    expect(field.transitions.some((row) => row.applicable
      && productSubjectId(row.from) === MEM.r && productSubjectId(row.to) === MEM.l
      && row.cap_contract_id !== SOFT)).toBe(true);
    expect(field.seeds.some((seed) => productSubjectId(seed.state) === MEM.l && seed.cap_contract_id === SOFT)).toBe(true);
    const delivered = index.entries.find((entry) => entry.object_id === MEM.l);
    expect(delivered?.association_milligrades).toBeGreaterThan(0);
    const rootId = delivered?.explanation_ids[0];
    expect(rootId).toEqual(expect.any(String));
    expect(proofKinds(grounded, rootId!)).toContain("or");
    expect(proofMentions(grounded, rootId!, MEM.r)).toBe(true);
    expect(delivered?.association_milligrades).toBe(1000);
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

  it("delivers a Soft-only seed through an applicable Hard transfer with its measurement provenance", async () => {
    const { field, index } = await observeAndProject({
      stored: [MEM.r, MEM.c], nominate: [MEM.r], lexical: [], relation: [MEM.r, MEM.c]
    });
    const transferred = field.transitions.find((row) => row.applicable
      && productSubjectId(row.from) === MEM.r && productSubjectId(row.to) === MEM.c);
    expect(transferred).toBeDefined();
    expect(transferred?.cap_contract_id).not.toBe(SOFT);
    expect(field.seeds.some((seed) => productSubjectId(seed.state) === MEM.r
      && seed.cap_contract_id === SOFT && seed.milligrades === 800)).toBe(true);
    const value = field.binding.kind === "bound"
      ? field.binding.snapshot.values.find((row) => productSubjectId(row.state) === MEM.c)
      : undefined;
    expect(value).toMatchObject({ activation: { kind: "reachable" }, cap_contract_id: SOFT });
    expect(value?.milligrades).toBe(800);
    expect(field.seeds.every(seed => seed.cap_contract_id === SOFT)).toBe(true);
    expect(index.entries.some((entry) => entry.object_id === MEM.c)).toBe(true);
  });

  it.each(["serial", "and", "or"] as const)("carries a measured seed through compiled Hard %s premises", async shape => {
    const { field, index, grounded } = await observeAndProject({ stored: [MEM.r, MEM.c], nominate: [MEM.r], lexical: [],
      relation: [MEM.r, MEM.c], shape });
    expect(field.seeds.some(seed => seed.cap_contract_id === SOFT && seed.milligrades === 800)).toBe(true);
    const delivered = index.entries.find(entry => entry.object_id === MEM.c);
    expect(delivered?.association_milligrades).toBe(800);
    expect(delivered?.explanation_ids.length).toBeGreaterThan(0);
    expect(proofMentions(grounded, delivered!.explanation_ids[0]!, MEM.r)).toBe(true);
    expect(field.seeds.every(seed => seed.cap_contract_id === SOFT)).toBe(true);
  });

  it.each(["missing", "below"] as const)("keeps lexical access without fabricating a measurement route (%s)", async measurement => {
    const { field, index, grounded } = await observeAndProject({ stored: [MEM.r, MEM.c],
      nominate: [MEM.r], relation: [MEM.r, MEM.c], measurement });
    expect(field.seeds.length).toBeGreaterThan(0);
    expect(field.seeds.every(seed => seed.cap_contract_id === hardIdentityCapContractId())).toBe(true);
    expect(index.entries.some(entry => entry.object_id === MEM.r)).toBe(true);
    expect(grounded.derivations.some(row => row.kind === "leaf" && row.association_milligrades !== 1000)).toBe(false);
    const noAccess = await observeAndProject({ stored: [MEM.r, MEM.c], nominate: [MEM.r], lexical: [],
      relation: [MEM.r, MEM.c], measurement });
    expect(noAccess.field.seeds).toHaveLength(0);
    expect(noAccess.index.entries).toHaveLength(0);
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
    // Both independent routes remain in the explanation; fund their full forest.
    budget: defaultBudget({ finalization_reserve: 1_000 }),
    derivations: grounded.derivations,
    output_derivations: grounded.roots,
    grounding_complete: grounded.complete
  });
  return { grounded, index };
}

type ObserveCase = Readonly<{
  readonly stored: readonly string[];
  readonly nominate: readonly string[];
  readonly lexical?: readonly string[];
  readonly measurement?: "missing" | "below";
  readonly shape?: "serial" | "and" | "or";
  readonly relation: readonly [string, string];
  readonly measure?: boolean;
  readonly authorizedScopes?: readonly string[] | null;
  readonly tombstone?: string;
}>;

async function observeCase(input: ObserveCase) {
  const slice = await openSourceSlice((database) => databases.add(database));
  for (const objectId of input.stored) {
    const nominated = (input.lexical ?? input.nominate).includes(objectId);
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
  const compiled = interpretation(measure, input.shape);
  expect(compiled.status).toBe("partial");
  expect(compiled.interpretation_proposal?.producer_id).toBe("alaya.query.proposal.core.v1");
  return observeField(compiled, {
    workspace_id: WS,
    query_text: "related",
    as_of: AS_OF,
    authorized_scopes: input.authorizedScopes === undefined ? null : input.authorizedScopes,
    budget: defaultBudget({ work_units: 10_000, memory_bytes: 1_000_000 }),
    readers: readersFor(slice, input.nominate, measure, input.lexical ?? input.nominate, input.measurement)
  });
}

function readersFor(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  nominate: readonly string[],
  measure: boolean,
  lexical: readonly string[],
  measurement?: "missing" | "below"
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
        object: measurement === "missing" ? null : vector(objectId, lexical.includes(objectId), measurement === "below"), query: vector("query"),
        objectStatus: measurement === "missing" ? "missing" as const : "ready" as const, queryStatus: "ready" as const, rowVisits: 2, bytesRead: 16
      })
    } : {}),
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
  };
}

function interpretation(measure: boolean, shape?: ObserveCase["shape"]): QueryInterpretation {
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
  return compileConditionalFieldQuery({
    source: "ordinary", text: "related", snapshot_id: SNAPSHOT_ID,
    interpretation_clock: AS_OF, budget: defaultBudget(), view: defaultView(),
    interpretation_proposal: {
      schema_version: 1, original_query_digest: digestOriginalQuery("related"),
      producer_id: "alaya.query.proposal.core.v1", program: shape === undefined ? program
        : shape === "serial" ? { schema_version: 1, kind: "sequence", steps: [program.body, { schema_version: 1, kind: "epsilon" }] }
        : { schema_version: 1, kind: "hyperedge", join: shape, premises: [program.body, { schema_version: 1, kind: "epsilon" }] },
      ...(measure ? { stored_cosine_admission: {
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
        } } : {})
    }
  });
}

function vector(objectId: string, lexical = true, below = false) {
  const content = `${lexical ? "related" : "other"} ${objectId}`;
  return {
    object_id: objectId,
    model_id: "stored-fixture",
    provider_kind: "openai" as const,
    schema_version: 1,
    dimensions: 2,
    content_hash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    embedding: new Float32Array(below ? [0, 1] : objectId === "query" ? [1, 0] : [3, 4])
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
