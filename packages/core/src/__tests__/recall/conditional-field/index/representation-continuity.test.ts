import { describe, expect, it } from "vitest";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { groundedOutputDerivations, type GroundingProgress } from "../../../../recall/conditional-field/engine/output-derivations.js";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  DerivationSchema,
  InformationIndexSchema,
  type Derivation,
  type SupportRecord,
  type Witness
} from "@do-soul/alaya-protocol";
import {
  continueAcceptingIndex,
  indexEntryRevision,
  outputAttributionHandle,
  projectAcceptingIndex,
  witnessAttributionHandle,
  type AcceptingProjectionInput
} from "../../../../recall/conditional-field/index/project-accepting-index.js";
import {
  composeCompleteness
} from "../../../../recall/conditional-field/index/completeness.js";

const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
const OTHER_GENERATION = `sha256:${"d".repeat(64)}`;
const QUERY_ID = "failed-deployment";
const RESULT_VERSION = "v1";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const EVENING = "2026-09-06T23:59:59.000Z";
const MORNING = "2026-09-07T00:00:01.000Z";

describe("index representation continuity", () => {
  it("redelivers semantic refinements and suppresses unchanged products through terminal projection", () => {
    const value = fieldValue("same", 400);
    const key = productStateNodeId(value.state);
    const input = baseInput({ snapshot: snapshotOf([value]), resource_work: "open", expires_at: EXPIRES_AT,
      delivered_product_ids: new Set(), delivered_entry_revisions: {}, projection_scan_offset: 0 });
    const first = projectAcceptingIndex(input);
    expect(first.entries).toHaveLength(1);
    const ledger = { [key]: indexEntryRevision(first.entries[0]!) };
    const continued = { ...input, delivered_product_ids: new Set([key]), delivered_entry_revisions: ledger,
      prior_continuation: first.continuation };
    expect(projectAcceptingIndex(continued).entries).toEqual([]);
    const stronger = projectAcceptingIndex({ ...continued, snapshot: snapshotOf([fieldValue("same", 900)]) });
    expect(stronger.entries[0]?.association_milligrades).toBe(900);
    ledger[key] = indexEntryRevision(stronger.entries[0]!);
    const supported = projectAcceptingIndex({ ...continued, snapshot: snapshotOf([fieldValue("same", 900)]),
      claims: new Map([[key, "supported" as const]]) });
    expect(supported.entries[0]?.claim).toBe("supported");
    ledger[key] = indexEntryRevision(supported.entries[0]!);
    const explainedInput = { ...continued, snapshot: snapshotOf([fieldValue("same", 900)]),
      claims: new Map([[key, "supported" as const]]), derivations: [leaf("same")],
      output_derivations: { [key]: [leaf("same").derivation_id] }, resource_work: undefined };
    const explained = projectAcceptingIndex(explainedInput);
    expect(explained.entries).toHaveLength(1);
    expect(explained.entries[0]?.explanation_ids.length).toBeGreaterThan(0);
    expect(explained.continuation).toBeNull();
    ledger[key] = indexEntryRevision(explained.entries[0]!);
    expect(projectAcceptingIndex(explainedInput).entries).toEqual([]);
  });

  it.each([false, true])("does not let an ungrounded earlier value block a later proved seed (accepting=%s)", (accepting) => {
    const a = fieldValue("a", 800, { program_state: accepting ? "accepting" : "routing", accepting });
    const z = fieldValue("z", 900);
    const seeds = [z, a].map((value) => ({ schema_version: 1 as const, state: value.state, milligrades: value.milligrades ?? 0 }));
    const ground = groundedOutputDerivations({ seeds, transitions: [], derivations: [], transition_derivations: {}, allowance: 1 });
    expect(ground.complete).toBe(false);
    let scanOffset = 0;
    const input = baseInput({ snapshot: { ...snapshotOf([a, z]), seeds }, remaining_reserve: 10,
      derivations: ground.derivations, output_derivations: ground.roots, grounding_progress: ground.progress,
      grounding_complete: false, resource_work: "open", expires_at: EXPIRES_AT,
      delivered_product_ids: new Set(), projection_scan_offset: 0,
      on_projection_progress: (offset) => { scanOffset = offset; } });
    const first = projectAcceptingIndex(input);
    expect(first.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["z"]);
    expect(scanOffset).toBe(2);
    const resumed = projectAcceptingIndex({ ...input, prior_continuation: first.continuation,
      projection_scan_offset: scanOffset, delivered_product_ids: new Set([productStateNodeId(z.state)]),
      derivations: [], output_derivations: undefined, transition_derivations: {}, resource_work: undefined });
    expect(resumed.entries.map((entry) => (entry.object_id ?? ""))).toEqual(accepting ? ["a"] : []);
    expect(resumed.continuation).toBeNull();
  });

  it("emits an incomplete-grounding seed only when its own retained leaf proves the full grade", () => {
    const value = fieldValue("seed", 900);
    const root = { ...leaf("seed"), association_milligrades: 900 };
    const input = baseInput({ snapshot: { ...snapshotOf([value]), seeds: [{ schema_version: 1, state: value.state, milligrades: 900 }] },
      derivations: [root], grounding_complete: false, remaining_reserve: 10, expires_at: EXPIRES_AT });
    expect(projectAcceptingIndex(input).entries.map((entry) => (entry.object_id ?? ""))).toEqual(["seed"]);
    expect(projectAcceptingIndex({ ...input, derivations: [{ ...root, association_milligrades: 800 }] }).entries).toEqual([]);
    expect(projectAcceptingIndex({ ...input, derivations: [] }).entries).toEqual([]);
    expect(projectAcceptingIndex({ ...input, snapshot: { ...input.snapshot, seeds: [] } }).entries).toEqual([]);
  });

  it("keeps program_state and time_state in the accepting key", () => {
    const index = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([
        fieldValue("cfg", 850, { program_state: "accepting", time_state: "yesterday" }),
        fieldValue("cfg", 850, { program_state: "mid", time_state: "yesterday", accepting: true }),
        fieldValue("cfg", 400, { program_state: "accepting", time_state: "last-week" })
      ])
    }));
    expect(index.entries).toHaveLength(3);
    expect(new Set(index.entries.map(acceptingKey)).size).toBe(3);
    expect(index.entries.every((entry) => entry.program_state !== undefined)).toBe(true);
    expect(index.entries.every((entry) => entry.time_state !== undefined)).toBe(true);
    const plantedMerge = index.entries.filter((entry) => (entry.object_id ?? "") === "cfg");
    expect(plantedMerge).toHaveLength(3);
  });

  it("keeps interpretation coverage open when one resolved page is complete", () => {
    const index = projectAcceptingIndex(deploymentInput({
      interpretation_status: "hypotheses",
      observer: {
        outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "exhausted" },
        open_regions: []
      }
    }));
    const parsed = InformationIndexSchema.parse(index);
    expect(parsed.completeness.logical_index).toBe("complete");
    expect(parsed.completeness.observed_coverage).toBe("complete");
    expect(parsed.completeness.interpretation_coverage).toBe("open");
    const plantedCertainty = composeCompleteness({
      observer: {
        outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "exhausted" }
      },
      interpretation_status: "resolved",
      total: parsed.entries.length,
      remaining: 0,
      omitted_payload: false,
      expand_payload: true
    });
    expect(plantedCertainty.interpretation_coverage).toBe("complete");
    expect(plantedCertainty.interpretation_coverage)
      .not.toBe(parsed.completeness.interpretation_coverage);
  });

  it("references AND/OR derivations instead of a flattened source list", () => {
    const a = leaf("a");
    const b = leaf("b");
    const c = leaf("c");
    const andAb = node("and-ab", "and", [a, b]);
    const orLeft = node("or-left", "or", [andAb, c]);
    const orAb = node("or-ab", "or", [a, b]);
    const andRight = node("and-right", "and", [orAb, c]);
    const cheap = witness("cheap-or", ["c"], 1);
    const expensive = witness("expensive-and", ["a", "b"], 900);
    const orIndex = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("c", 850)]),
      derivations: [a, b, c, andAb, orLeft],
      support: [supportRecord([cheap, expensive])],
      budget: defaultBudget({ page_budget: 800 })
    }));
    expect(orIndex.entries[0]?.explanation_ids).toEqual(["or-left"]);
    expect(orIndex.entries[0]?.explanation_ids).not.toEqual(["a", "b", "c"]);
    expect(orIndex.entries[0]?.association_milligrades).toBe(850);
    const andIndex = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("c", 850)]),
      derivations: [a, b, c, orAb, andRight],
      support: [supportRecord([cheap, expensive])]
    }));
    expect(andIndex.entries[0]?.explanation_ids).toEqual(["and-right"]);
    expect(andIndex.entries[0]?.explanation_ids).not.toEqual(orIndex.entries[0]?.explanation_ids);
    const forest = new Map<string, Derivation>([
      [a.derivation_id, a],
      [b.derivation_id, b],
      [c.derivation_id, c],
      [andAb.derivation_id, andAb],
      [orLeft.derivation_id, orLeft],
      [orAb.derivation_id, orAb],
      [andRight.derivation_id, andRight]
    ]);
    expect(withdrawLeaf(forest, "or-left", "c")?.kind).toBe("and");
    expect(withdrawLeaf(forest, "and-right", "c")).toBeUndefined();
    const affordable = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("c", 850)]),
      support: [supportRecord([cheap, expensive])],
      budget: defaultBudget({ page_budget: 50 })
    }));
    expect(affordable.entries[0]?.explanation_ids).toEqual(["cheap-or"]);
    expect(affordable.entries[0]?.explanation_ids).not.toContain("expensive-and");
  });

  it("keeps source revisions on the referenced derivation, not a winning scalar", () => {
    const current = DerivationSchema.parse({
      schema_version: 1,
      derivation_id: "cfg-current",
      kind: "serial",
      children: ["cfg-leaf"],
      observation_ids: ["obs-1"],
      leaf_ids: ["cfg"],
      witness_id: "w-current",
      source_revisions: ["rev-2"]
    });
    const revoked = DerivationSchema.parse({
      schema_version: 1,
      derivation_id: "cfg-revoked",
      kind: "serial",
      children: ["cfg-leaf"],
      observation_ids: ["obs-0"],
      leaf_ids: ["cfg"],
      witness_id: "w-revoked",
      source_revisions: ["rev-1"]
    });
    const index = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("cfg", 850)]),
      derivations: [leaf("cfg-leaf"), current, revoked],
      support: [supportRecord([
        witness("w-current", ["cfg"], 1),
        witness("w-revoked", ["cfg"], 1)
      ])]
    }));
    expect(index.entries[0]?.explanation_ids).toEqual(["cfg-current", "cfg-revoked"]);
    expect(index.entries[0]?.explanation_ids).toContain("cfg-revoked");
    expect(current.source_revisions).toEqual(["rev-2"]);
    expect(revoked.source_revisions).not.toEqual(current.source_revisions);
  });

  it("invalidates an offset continuation reused against an empty field", () => {
    const first = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(first.continuation).not.toBeNull();
    expect(first.entries).toHaveLength(1);
    const reused = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([]),
      prior_continuation: first.continuation,
      expires_at: EXPIRES_AT
    }));
    expect(reused.entries).toEqual([]);
    expect(reused.completeness.logical_index).toBe("invalidated");
    expect(reused.completeness.observed_coverage).toBe("invalidated");
    expect(reused.continuation).toBeNull();
    const continued = continueAcceptingIndex(first, deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(continued.completeness.logical_index).not.toBe("invalidated");
    expect(continued.entries.map((entry) => (entry.object_id ?? "")))
      .not.toEqual(first.entries.map((entry) => (entry.object_id ?? "")));
  });

  it("omits mixed-generation payload without claiming a complete explanation", () => {
    const mixed = projectAcceptingIndex(deploymentInput({
      payload_generation: OTHER_GENERATION,
      support: [supportRecord([witness("for-r", ["r"], 1)])]
    }));
    expect(mixed.completeness.logical_index).toBe("complete");
    expect(mixed.completeness.payload).toBe("omitted");
    expect(mixed.entries.every((entry) => entry.explanation_ids.length === 0)).toBe(true);
    const sameGeneration = projectAcceptingIndex(deploymentInput({
      payload_generation: SNAPSHOT_ID,
      support: [supportRecord([witness("for-r", ["r"], 1)])]
    }));
    expect(sameGeneration.entries.find((entry) => (entry.object_id ?? "") === "r")?.explanation_ids)
      .toEqual(["for-r"]);
    expect(sameGeneration.completeness.payload).toBe("complete");
  });

  it("midnight interpretation identity cannot splice the previous page", () => {
    const evening = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      interpretation_clock: EVENING
    }));
    expect(evening.continuation?.interpretation_id).toBe(EVENING);
    const morning = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      interpretation_clock: MORNING,
      prior_continuation: evening.continuation
    }));
    expect(morning.completeness.logical_index).toBe("invalidated");
    expect(morning.completeness.observed_coverage).toBe("invalidated");
    expect(morning.entries).toEqual([]);
    const sameMorning = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      interpretation_clock: EVENING,
      prior_continuation: evening.continuation
    }));
    expect(sameMorning.completeness.logical_index).not.toBe("invalidated");
  });

  it("retains grounding so a one-unit continuation can deliver the requested entry", () => {
    const value = fieldValue("cfg", 850);
    let progress: GroundingProgress | undefined;
    let remaining = -1;
    const input: AcceptingProjectionInput = {
      ...baseInput({
        snapshot: {
          ...snapshotOf([value]),
          seeds: [{ schema_version: 1, state: value.state, milligrades: value.milligrades ?? 0 }]
        },
        remaining_reserve: 1,
        expires_at: EXPIRES_AT
      }),
      output_derivations: undefined,
      transition_derivations: {},
      on_grounding_progress: (next) => { progress = next; },
      on_remaining_reserve: (next) => { remaining = next; }
    };
    const first = projectAcceptingIndex(input);
    expect(first.entries).toEqual([]);
    expect(first.continuation).not.toBeNull();
    expect(first.completeness.logical_index).toBe("open");
    expect(progress?.completed_work).toBe(1);
    expect(remaining).toBe(0);
    const second = continueAcceptingIndex(first, { ...input, grounding_progress: progress });
    expect(second.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["cfg"]);
    expect(second.continuation).toBeNull();
    expect(progress?.completed_work).toBe(1);
    expect(remaining).toBe(0);
  });

  it("stops projection when the remaining reserve is exhausted", () => {
    const truncated = projectAcceptingIndex(deploymentInput({
      remaining_reserve: 0,
      expires_at: EXPIRES_AT
    }));
    expect(truncated.entries).toEqual([]);
    expect(truncated.completeness.logical_index).toBe("open");
    expect(truncated.completeness.representation).toBe("open");
    expect(truncated.completeness.logical_index).not.toBe("complete");
    const one = projectAcceptingIndex(deploymentInput({
      remaining_reserve: 1,
      expires_at: EXPIRES_AT
    }));
    expect(one.entries.length).toBeLessThanOrEqual(1);
    expect(one.completeness.logical_index).toBe("open");
  });

  it("resumes unfinished representation while observation stays exhausted", () => {
    const input = deploymentInput({ remaining_reserve: 1, expires_at: EXPIRES_AT,
      observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] } });
    const ids: string[] = [];
    let page = projectAcceptingIndex(input);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      ids.push(...page.entries.map((entry) => (entry.object_id ?? "")));
      expect(page.completeness.observed_coverage).toBe("complete");
      if (page.continuation === null) break;
      page = continueAcceptingIndex(page, input);
    }
    expect(page.continuation).toBeNull();
    expect(ids).toEqual(["c", "h", "l", "r"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("retries payload work at the same product cursor and charges its actual allowance", () => {
    const input = baseInput({ snapshot: snapshotOf([fieldValue("cfg", 850)]), remaining_reserve: 2,
      expires_at: EXPIRES_AT, observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] } });
    const first = projectAcceptingIndex({ ...input, finalize_payload: (_entries, remaining) => ({ remaining, complete: false }) });
    expect(first.continuation).not.toBeNull();
    const resumed = continueAcceptingIndex(first, { ...input, finalize_payload: (_entries, remaining) => ({ remaining: remaining - 1, complete: true }) });
    expect(resumed.entries.map((entry) => (entry.object_id ?? ""))).toEqual(["cfg"]);
    expect(resumed.continuation).toBeNull();
    expect(resumed.completeness.payload).toBe("complete");
  });

  it("exposure handles stay output- or witness-grained and do not claim use", () => {
    const index = projectAcceptingIndex(deploymentInput({
      support: [supportRecord([witness("for-r", ["r"], 1)])]
    }));
    const entry = index.entries.find((item) => (item.object_id ?? "") === "r");
    if (entry === undefined) throw new Error("expected requested entry");
    const output = outputAttributionHandle({
      entry,
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID
    });
    expect(output.grain).toBe("output");
    expect(output.exposure).toBe("exposed");
    expect(output.reported_use).toBe("unknown");
    expect(output.witness_id).toBeUndefined();
    expect(output.target).toEqual(entry.target);
    expect(output.object_id).toBe("r");
    const witnessReport = witnessAttributionHandle({
      entry,
      witness_id: "for-r",
      interpretation_id: "meaning-1",
      as_of: EVENING,
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID
    });
    expect(witnessReport.grain).toBe("witness");
    expect(witnessReport.witness_id).toBe("for-r");
    expect(witnessReport.reported_use).toBe("unknown");
    expect(witnessReport.output_id).toBeUndefined();
    expect(witnessReport.target).toEqual(entry.target);
    expect(witnessReport.object_id).toBe("r");
  });

  it("source-record attribution carries native target identity without minting an object id", () => {
    const sourceTarget = {
      kind: "source_evidence" as const,
      workspace_id: "ws",
      root_kind: "source_record" as const,
      root_id: "src-root",
      source_version: "rev",
      content_digest: SNAPSHOT_ID,
      evidence_object_id: null
    };
    const index = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("src-root", 900, { target: sourceTarget })])
    }));
    const entry = index.entries.find((item) => item.target.kind === "source_evidence");
    if (entry === undefined) throw new Error("expected source-record entry");
    expect(entry.object_id).toBeUndefined();
    const output = outputAttributionHandle({
      entry,
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID
    });
    expect(output.object_id).toBeUndefined();
    expect(output.target).toEqual(sourceTarget);
    const witnessReport = witnessAttributionHandle({
      entry,
      witness_id: "for-src",
      interpretation_id: "meaning-1",
      as_of: EVENING,
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID
    });
    expect(witnessReport.object_id).toBeUndefined();
    expect(witnessReport.target).toEqual(sourceTarget);
  });

  it("retains roles, association, and explanation references on the index", () => {
    const index = InformationIndexSchema.parse(projectAcceptingIndex(deploymentInput({
      support: [supportRecord([witness("for-r", ["r"], 1)])]
    })));
    const requested = index.entries.find((entry) => (entry.object_id ?? "") === "r");
    expect(requested?.role).toBe("requested");
    expect(requested?.association_milligrades).toBe(1000);
    expect(requested?.explanation_ids).toEqual(["for-r"]);
    expect(index.entries.some((entry) => (entry.object_id ?? "") === "h")).toBe(true);
    expect(index.representation.policy).toBe("construct_index_then_page_then_payload");
  });
});

function deploymentInput(
  overrides: Partial<AcceptingProjectionInput> = {}
): AcceptingProjectionInput {
  return baseInput({
    snapshot: snapshotOf([
      fieldValue("r", 1000),
      fieldValue("l", 950),
      fieldValue("c", 850),
      fieldValue("s", 900),
      fieldValue("h", 550)
    ]),
    roles: new Map([
      ["r", "requested"],
      ["l", "associated"],
      ["c", "associated"],
      ["s", "routing_only"],
      ["h", "associated"]
    ]),
    ...overrides
  });
}

function baseInput(overrides: Partial<AcceptingProjectionInput> = {}): AcceptingProjectionInput {
  const roles = new Map([...overrides.roles ?? []].map(([id, role]) => [productStateNodeId(fieldValue(id, 1).state), role]));
  const roots = (overrides.derivations ?? []).filter((node) => !(overrides.derivations ?? []).some((parent) => parent.children.includes(node.derivation_id)));
  return {
    snapshot: snapshotOf([]),
    view: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      requested_roles: ["requested", "associated"],
      include_routing_only: false,
      enumeration_policy: "canonical",
      result_kind_view: "mixed",
      facet_mode: "same_path",
      threshold_milligrades: 0
    },
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: RESULT_VERSION,
    budget: defaultBudget(),
    ...overrides,
    roles,
    output_derivations: overrides.output_derivations ?? Object.fromEntries((overrides.snapshot?.values ?? []).map((value) => [productStateNodeId(value.state), roots.map((root) => root.derivation_id)]))
  };
}

function snapshotOf(values: AcceptingProjectionInput["snapshot"]["values"]) {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    snapshot_id: SNAPSHOT_ID,
    query_id: QUERY_ID,
    seeds: [],
    values,
    retained_transitions: [],
    facets: []
  };
}

function fieldValue(
  objectId: string,
  milligrades: number,
  extras: Partial<AcceptingProjectionInput["snapshot"]["values"][number]["state"]> & {
    readonly accepting?: boolean;
  } = {}
) {
  const { accepting, ...state } = extras;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      target: { kind: "memory_entry" as const, workspace_id: "ws", object_id: objectId, source_revision: "rev" },
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of",
      ...state
    },
    milligrades,
    accepting: accepting ?? (state.program_state === undefined || state.program_state === "accepting")
  };
}

function defaultBudget(overrides: Partial<AcceptingProjectionInput["budget"]> = {}) {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    work_units: 10_000,
    memory_bytes: 1_000_000,
    page_budget: 800,
    finalization_reserve: 100,
    min_envelope: 10,
    ...overrides
  };
}

function leaf(id: string): Derivation {
  return DerivationSchema.parse({
    schema_version: 1,
    derivation_id: id,
    kind: "leaf",
    children: [],
    observation_ids: [id],
    leaf_ids: [id],
    source_revisions: [`src-${id}`]
  });
}

function node(
  id: string,
  kind: "serial" | "and" | "or",
  children: readonly Derivation[]
): Derivation {
  return DerivationSchema.parse({
    schema_version: 1,
    derivation_id: id,
    kind,
    children: children.map((child) => child.derivation_id),
    observation_ids: children.flatMap((child) => child.observation_ids),
    leaf_ids: children.flatMap((child) => child.leaf_ids),
    source_revisions: children.flatMap((child) => child.source_revisions)
  });
}

function withdrawLeaf(
  forest: ReadonlyMap<string, Derivation>,
  rootId: string,
  withdrawn: string
): Derivation | undefined {
  const current = forest.get(rootId);
  if (current === undefined) return undefined;
  if (current.kind === "leaf") {
    return current.derivation_id === withdrawn ? undefined : current;
  }
  const kept: Derivation[] = [];
  for (const childId of current.children) {
    const next = withdrawLeaf(forest, childId, withdrawn);
    if (next !== undefined) kept.push(next);
  }
  if (current.kind === "and" && kept.length !== current.children.length) return undefined;
  if (kept.length === 0) return undefined;
  if (kept.length === 1 && current.kind === "or") return kept[0];
  return node(`${current.derivation_id}-w`, current.kind, kept);
}

function witness(id: string, premises: readonly string[], cost: number): Witness {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    witness_id: id,
    premises,
    cost,
    complete: true
  };
}

function supportRecord(witnesses: readonly Witness[]): SupportRecord {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    proposition_id: "cause",
    claim: "unknown",
    witnesses
  };
}

function acceptingKey(entry: {
  readonly object_id?: string;
  readonly hypothesis_id: string;
  readonly output_binding: string;
  readonly program_state?: string;
  readonly time_state?: string;
}): string {
  return [
    (entry.object_id ?? ""),
    entry.hypothesis_id,
    entry.output_binding,
    entry.program_state ?? "",
    entry.time_state ?? ""
  ].join("\0");
}
